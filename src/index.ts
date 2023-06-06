import fs from 'node:fs'
import path from 'node:path'
import type { PluginContext } from 'rollup'
import {
  type Plugin,
  type ResolvedConfig,
  normalizePath,
} from 'vite'
import {
  MagicString,
  cleanUrl,
  node_modules as find_node_modules,
  relativeify,
} from 'vite-plugin-utils/function'

export interface NativeOptions {
  /**
   * Where we want to physically put the extracted `.node` files
   * @default 'dist-native'
   */
  outDir?: string
  /**
   * - Modify the final filename for specific modules
   * - A function that receives a full path to the original file, and returns a desired filename
   * - Or a function that returns a desired file name and a specific destination to copy to
   * @experimental
   * @todo better calculation value of `id` automatically
   */
  map?: (mapping: {
    /** `.node` file path */
    native: string
    /** require id of `.node` file */
    id: string
    /** `.node` file output location */
    output: string
  }) => typeof mapping
  /**
   * - Use `dlopen` instead of `require`/`import`
   * - This must be set to true if using a different file extension that `.node`
   */
  dlopen?: boolean
  /**
   * If the target is `esm`, so we can't use `require` (and `.node` is not supported in `import` anyway), we will need to use `createRequire` instead 
   * @default 'cjs'
   */
  target?: 'cjs' | 'esm'
}

export type Mapping = ReturnType<NonNullable<NativeOptions['map']>>

const TAG = '[vite-plugin-native]'
const PREFIX = '\0native:'
let config: ResolvedConfig
const opts: Required<NativeOptions> = {
  outDir: 'dist-native',
  map: mapping => mapping,
  dlopen: false,
  target: 'cjs',
}
const moduleCache = new Map<string, Mapping>()

export default function native(options: NativeOptions = {}): Plugin[] {
  return [
    {
      name: 'vite-plugin-native:resolve',
      enforce: 'pre',
      resolveId(importee, importer) {
        if (importee.startsWith(PREFIX)) return importee

        // Avoid trouble with other plugins like commonjs
        if (importee.endsWith('?commonjs-require'))
          importee = importee.slice(1, -'?commonjs-require'.length)

        // Remove the `\0` PREFIX
        if (importer?.startsWith('\0') && importer.includes(':'))
          importer = importer.slice(importer.indexOf(':') + 1)
        if (importee.startsWith('\0') && importee.includes(':'))
          importee = importee.slice(importee.indexOf(':') + 1)

        return mapAndReturnPrefixedId.call(this, importee, importer)
      },
    },
    {
      name: 'vite-plugin-native',
      configResolved(_config) {
        config = _config

        // NativeOptions initialize
        Object.assign(opts, options)
        opts.outDir = path.posix.resolve(_config.root, normalizePath(opts.outDir))

        fs.mkdirSync(opts.outDir, { recursive: true })
      },
      load(id) {
        if (id.startsWith(PREFIX)) {
          return exportModule(id.slice(PREFIX.length))
        }

        const module = moduleCache.get(id)
        if (module) {
          return exportModule(module.id)
        }
      },
      transform(code, id) {
        const ms = new MagicString(code)
        const bindingsRgx = /require\(['"]bindings['"]\)\(((['"]).+?\2)?\)/g
        const simpleRequireRgx = /require\(['"](.*?)['"]\)/g // TODO: use AST parser
        const clean_id = cleanUrl(id.startsWith('\0') ? id.replace('\0', '') : id)
        const node_modules = find_node_modules(clean_id)[0]

        if (!node_modules) return

        // 🚧 node-gyp-build
        // ❌ prebuilds/[platform][+arch]/node.napi[.arch].node
        const hasBindingReplacements = replace(
          code,
          ms,
          bindingsRgx,
          match => {
            const [, name] = match

            let nativeAlias: string = name ? new Function('return ' + name)() : /* node-gyp-build */'bindings.node'
            if (!nativeAlias.endsWith('.node'))
              nativeAlias += '.node'

            const partsMap: Record<string, any> = Object.create({
              compiled: process.env.NODE_BINDINGS_COMPILED_DIR || 'compiled',
              platform: process.platform,
              arch: process.arch,
              version: process.versions.node,
              bindings: nativeAlias,
              module_root: node_modules,
            })

            const possibilities = [
              ['module_root', 'build', 'bindings'],
              ['module_root', 'build', 'Debug', 'bindings'],
              ['module_root', 'build', 'Release', 'bindings'],
              ['module_root', 'compiled', 'version', 'platform', 'arch', 'bindings'],
            ]

            const possiblePaths = possibilities.map(parts => {
              parts = parts.map(part => {
                if (partsMap[part])
                  return partsMap[part]
                return part
              })
              return path.posix.join(...parts)
            })

            const chosenPath = possiblePaths.find(x => fs.existsSync(x)) || possiblePaths[0]

            const prefixedId = mapAndReturnPrefixedId.apply(this, [chosenPath])
            if (prefixedId) {
              return `require(${JSON.stringify(prefixedId)})`
            }
          },
        )

        const hasRequireReplacements = replace(
          code,
          ms,
          simpleRequireRgx,
          match => {
            let [, name] = match

            if (!name.endsWith('.node'))
              name += '.node'

            name = path.join(node_modules, name)

            if (fs.existsSync(name)) {
              const prefixedId = mapAndReturnPrefixedId.apply(this, [name])
              if (prefixedId) {
                return `require(${JSON.stringify(prefixedId)})`
              }
            }
          },
        )

        // ✅ `node-pre-gyp`, get the actual `.node` file path by calling `require('node-pre-gyp').find()`
        // @see - https://github.com/springmeyer/node-addon-example/blob/v0.1.5/index.js#L1-L4
        let hasBinaryReplacements = false
        if (code.includes('node-pre-gyp')) {
          const node_pre_gyp_Rgx = /(var|let|const)\s+([a-zA-Z0-9_]+)\s+=\s+require\((['"])(@mapbox\/node-pre-gyp|node-pre-gyp)\3\);?/g
          const node_pre_gyp_Match = node_pre_gyp_Rgx.exec(code)
          const binaryRgx = node_pre_gyp_Match
            ? new RegExp(`\\b(var|let|const)\\s+([a-zA-Z0-9_]+)\\s+=\\s+${node_pre_gyp_Match[2]}\\.find\\(path\\.resolve\\(path\\.join\\(__dirname,\\s*((?:['"]).*\\4)\\)\\)\\);?\\s*(var|let|const)\\s+([a-zA-Z0-9_]+)\\s+=\\s+require\\(\\2\\)`, 'g')
            : /\b(var|let|const)\s+([a-zA-Z0-9_]+)\s+=\s+binary\.find\(path\.resolve\(path\.join\(__dirname,\s*((?:['"]).*\4)\)\)\);?\s*(var|let|const)\s+([a-zA-Z0-9_]+)\s+=\s+require\(\2\)/g

          hasBinaryReplacements = replace(
            code,
            ms,
            binaryRgx,
            match => {
              let node_pre_gyp: any

              // We can't simply require('node-pre-gyp') because we are not in the same context as the target module
              // Maybe node-pre-gyp is installed in node_modules/target_module/node_modules
              let node_pre_gyp_path = path.dirname(clean_id)
              let node_pre_gyp_path_pre: string | undefined
              while (node_pre_gyp_path !== node_pre_gyp_path_pre) {
                // Start with the target module context and then go back in the directory tree
                // until the right context has been found
                try {
                  // noinspection NpmUsedModulesInstalled
                  node_pre_gyp ??= require(path.resolve(path.join(node_pre_gyp_path, 'node_modules', '@mapbox/node-pre-gyp')))
                } catch { }
                try {
                  // noinspection NpmUsedModulesInstalled
                  node_pre_gyp ??= require(path.resolve(path.join(node_pre_gyp_path, 'node_modules', 'node-pre-gyp')))
                } catch { }

                if (node_pre_gyp) break

                // lookup
                node_pre_gyp_path_pre = node_pre_gyp_path
                node_pre_gyp_path = path.dirname(node_pre_gyp_path)
              }

              if (!node_pre_gyp) return

              let [, d1, v1, ref, d2, v2] = match

              const libPath = node_pre_gyp.find(path.resolve(path.join(path.dirname(clean_id), new Function('return ' + ref)())), options)

              const prefixedId = mapAndReturnPrefixedId.apply(this, [libPath])
              if (prefixedId) {
                return `${d1} ${v1}=${JSON.stringify(moduleCache.get(libPath)!.id.replace(/\\/g, '/'))};${d2} ${v2}=require(${JSON.stringify(prefixedId)})`
              }
            },
          )

          // If the native module has been required through a hard-coded path, then node-pre-gyp
          // is not required anymore - remove the require('node-pre-gyp') statement because it
          // pulls some additional dependencies - like AWS S3 - which are needed only for downloading
          // new binaries
          if (hasBinaryReplacements)
            replace(code, ms, node_pre_gyp_Rgx, () => '')
        }

        // 🤔 opinionated
        // @see - https://github.com/serialport/bindings-cpp/blob/v11.0.1/lib/load-bindings.ts#L1
        if (/(require\("node-gyp-build"\))/.test(code)) {
          try {

          } catch { }
          const load = require('node-gyp-build')
          const libRoot = path.join(path.dirname(clean_id), '..')
          // @see - https://github.com/serialport/bindings-cpp/blob/v11.0.1/lib/load-bindings.ts#L6
          const libPath = load.resolve(libRoot)

          const prefixedId = mapAndReturnPrefixedId.apply(this, [libPath])
          if (prefixedId) {
            // const lib = require('lib-esm')({ exports: Object.keys(load(libRoot)) })
            // ❌ can not works with @rollup/plugin-commonjs
            // return `const _M_=require(${JSON.stringify(prefixedId)});\n${lib.exports}`

            // ✅ works fine with @rollup/plugin-commonjs
            return `const binding = require(${JSON.stringify(prefixedId)});\nmodule.exports = exports = binding;`
          }
        }

        if (![
          hasBindingReplacements,
          hasRequireReplacements,
          hasBinaryReplacements,
        ].some(Boolean)) return

        return ms.toString()
      },
    },
  ]
}

function exportModule(id: string) {
  if (opts.dlopen)
    return `
function load_module() {
  let p = require("path").resolve(__dirname, ${JSON.stringify(id)});
  if (!require.cache[p]) {
    let module = { exports: {} };
    process.dlopen(module, p);
    require.cache[p] = module;
  }
  // Fool other plugins, leave this one alone! (Resilient to uglifying too)
  let req = require || require;
  return req(p);
};
export default load_module();
`

  if (opts.target === 'esm')
    return `
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
export default require(${JSON.stringify(id)});
`

  return `export default require(${JSON.stringify(id)});\n`
}

function replace(
  code: string,
  ms: MagicString,
  pattern: RegExp,
  fn: (match: RegExpExecArray) => void | string,
) {
  pattern.lastIndex = 0

  let match
  while ((match = pattern.exec(code))) {
    const replacement = fn(match)
    if (replacement == null) continue

    const start = match.index
    const end = start + match[0].length
    ms.overwrite(start, end, replacement)

    return true
  }

  return false
}

function generateDefaultMapping(native: string): Mapping {
  const basename = path.basename(native)
  // If the user output the file name with a dir, then `relativePath` based on `outDir` will no longer be correct.
  // e.g. - `js/[name].js`
  // TODO: better calculation value of `id` automatically
  const outDir = path.posix.resolve(config.root, config.build.outDir)
  const relativePath = relativeify(path.posix.relative(outDir, opts.outDir))
  return {
    native,
    id: path.posix.join(relativePath, basename),
    output: path.join(opts.outDir, basename),
  }
}

function mapAndReturnPrefixedId(this: PluginContext, importee: string, importer?: string) {
  const resolvedPath = path.posix.resolve(importer ? path.dirname(importer) : '', importee)

  let native: string | undefined
  if (/\.(node|dll)$/i.test(importee))
    native = resolvedPath
  else if (fs.existsSync(resolvedPath + '.node'))
    native = resolvedPath + '.node'
  else if (fs.existsSync(resolvedPath + '.dll'))
    native = resolvedPath + '.dll'

  if (native) {
    let module = moduleCache.get(native)

    if (!module) {
      const mapping = generateDefaultMapping(native)
      moduleCache.set(native, module = opts.map(mapping) ?? mapping)

      if (fs.existsSync(native)) {
        fs.copyFileSync(native, module.output)
      } else {
        this.warn(`${TAG} ${native} does not exist`)
      }
    }

    return PREFIX + module.id
  }
}
