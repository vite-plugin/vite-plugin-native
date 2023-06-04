import fs from 'node:fs'
import path from 'node:path'
import type { PluginContext } from 'rollup'
import {
  type Plugin,
  normalizePath,
} from 'vite'
import {
  MagicString,
  node_modules as find_node_modules,
} from 'vite-plugin-utils/function'

export interface NativeOptions {
  /** Where we want to physically put the extracted .node files */
  copyTo?: string
  /** Path to the same folder, relative to the output bundle js */
  destDir?: string
  /**
   * - Use `dlopen` instead of `require`/`import`.
   * - This must be set to true if using a different file extension that '.node'
   */
  dlopen?: boolean
  /**
   * - Modify the final filename for specific modules
   * - A function that receives a full path to the original file, and returns a desired filename
   * - Or a function that returns a desired file name and a specific destination to copy to
   */
  map?: (modulePath: string) => string | { name: string; copyTo: string }
  /** If the target is ESM, so we can't use `require` (and .node is not supported in `import` anyway), we will need to use `createRequire` instead. */
  target?: 'esm' | 'cjs'
  platform?: typeof process.platform
  arch?: typeof process.arch
}

const TAG = '[vite-plugin-native]'
const PREFIX = '\0native:'
const opts: Required<NativeOptions> = {
  copyTo: 'dist/native',
  destDir: './',
  dlopen: false,
  map: modulePath => generateDefaultMapping(modulePath),
  target: 'cjs',
  platform: process.platform,
  arch: process.arch
}
const moduleCache = new Map<string, { name: string; copyTo: string; }>()

export default function native(options: NativeOptions = {}): Plugin[] {
  Object.assign(opts, options)
  opts.copyTo = normalizePath(opts.copyTo)
  opts.destDir = normalizePath(opts.destDir)

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
      config() {
        if (fs.existsSync(opts.copyTo)) {
          fs.mkdirSync(opts.copyTo, { recursive: true })
        }
      },
      load(id) {
        if (id.startsWith(PREFIX)) {
          return exportModule(id.slice(PREFIX.length))
        }

        // 🤔 never
        //´👉 https://github.com/danielgindi/rollup-plugin-natives/blob/0.7.6/src/index.js#L155
        // const module = moduleCache.get(id)
        // if (module) {
        //   return exportModule(module.name)
        // }
      },
      transform(code, id) {
        const ms = new MagicString(code)
        const bindingsRgx = /require\(['"]bindings['"]\)\(((['"]).+?\2)?\)/g
        const simpleRequireRgx = /require\(['"](.*?)['"]\)/g // TODO: use AST parser
        const node_modules = find_node_modules(id)[0]

        const hasBindingReplacements = replace(
          code,
          ms,
          bindingsRgx,
          match => {
            const name = match[1]

            let nativeAlias: string = name ? new Function('return ' + name)() : 'bindings.node';
            if (!nativeAlias.endsWith('.node'))
              nativeAlias += '.node'

            const partsMap: Record<string, any> = Object.create({
              compiled: process.env.NODE_BINDINGS_COMPILED_DIR || 'compiled',
              platform: opts.platform,
              arch: opts.arch,
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
            let name = match[1]

            if (!name.endsWith('.node'))
              name += '.node'

            name = path.join(node_modules, name)

            if (fs.existsSync(name)) {
              let prefixedId = mapAndReturnPrefixedId.apply(this, [name])
              if (prefixedId) {
                return `require(${JSON.stringify(prefixedId)})`
              }
            }
          },
        )

        let hasBinaryReplacements = false
        if (code.includes('node-pre-gyp')) {
          const varRgx = /(var|let|const)\s+([a-zA-Z0-9_]+)\s+=\s+require\((['"])(@mapbox\/node-pre-gyp|node-pre-gyp)\3\);?/g
          const varMatch = varRgx.exec(code)
          const binaryRgx = varMatch
            ? new RegExp(`\\b(var|let|const)\\s+([a-zA-Z0-9_]+)\\s+=\\s+${varMatch[2]}\\.find\\(path\\.resolve\\(path\\.join\\(__dirname,\\s*((?:['"]).*\\4)\\)\\)\\);?\\s*(var|let|const)\\s+([a-zA-Z0-9_]+)\\s+=\\s+require\\(\\2\\)`, 'g')
            : /\b(var|let|const)\s+([a-zA-Z0-9_]+)\s+=\s+binary\.find\(path\.resolve\(path\.join\(__dirname,\s*((?:['"]).*\4)\)\)\);?\s*(var|let|const)\s+([a-zA-Z0-9_]+)\s+=\s+require\(\2\)/g

          hasBinaryReplacements = replace(
            code,
            ms,
            binaryRgx,
            match => {
              let preGyp = null

              const r1 = varMatch && varMatch[4][0] === '@' ? '@mapbox/node-pre-gyp' : 'node-pre-gyp'
              const r2 = varMatch && varMatch[4][0] === '@' ? 'node-pre-gyp' : '@mapbox/node-pre-gyp'

              // We can't simply require('node-pre-gyp') because we are not in the same context as the target module
              // Maybe node-pre-gyp is installed in node_modules/target_module/node_modules
              let preGypPath = path.dirname(id)
              while (preGypPath !== '/' && preGyp == null) {
                // Start with the target module context and then go back in the directory tree
                // until the right context has been found
                try {
                  // noinspection NpmUsedModulesInstalled
                  preGyp = require(path.resolve(path.join(preGypPath, 'node_modules', r1)))
                } catch (ex) {
                  try {
                    // noinspection NpmUsedModulesInstalled
                    preGyp = require(path.resolve(path.join(preGypPath, 'node_modules', r2)))
                  } catch (ex) {
                    // ignore
                  }
                }
                preGypPath = path.dirname(preGypPath)
              }

              if (!preGyp) return

              let [, d1, v1, ref, d2, v2] = match

              const libPath = preGyp.find(path.resolve(path.join(path.dirname(id), new Function('return ' + ref)())), options)

              let prefixedId = mapAndReturnPrefixedId.apply(this, [libPath])
              if (prefixedId) {
                return `${d1} ${v1}=${JSON.stringify(moduleCache.get(libPath)!.name.replace(/\\/g, '/'))};${d2} ${v2}=require(${JSON.stringify(prefixedId)})`
              }
            },
          )

          // If the native module has been required through a hard-coded path, then node-pre-gyp
          // is not required anymore - remove the require('node-pre-gyp') statement because it
          // pulls some additional dependencies - like AWS S3 - which are needed only for downloading
          // new binaries
          if (hasBinaryReplacements)
            replace(code, ms, varRgx, () => '')
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

function rebaseModule(basename: string) {
  return (opts.destDir + (/\\$|\/$/.test(opts.destDir) ? '' : '/') + basename).replace(/\\/g, '/')
}

function findAvailableBasename(nativePath: string) {
  let basename = path.basename(nativePath)

  let i = 1
  while (Array.from(moduleCache.values()).filter(x => x.name === rebaseModule(basename)).length) {
    basename = path.basename(nativePath, path.extname(nativePath)) + '_' + (i++) + path.extname(nativePath)
  }

  return basename
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

function generateDefaultMapping(nativePath: string) {
  const basename = findAvailableBasename(nativePath)

  return {
    name: rebaseModule(basename),
    copyTo: path.posix.join(opts.copyTo, basename),
  }
}

function mapAndReturnPrefixedId(this: PluginContext, importee: string, importer?: string) {
  const resolvedPath = path.posix.resolve(importer ? path.dirname(importer) : '', importee)

  let nativePath: string | undefined
  if (/\.(node|dll)$/i.test(importee))
    nativePath = resolvedPath
  else if (fs.existsSync(resolvedPath + '.node'))
    nativePath = resolvedPath + '.node'
  else if (fs.existsSync(resolvedPath + '.dll'))
    nativePath = resolvedPath + '.dll'

  if (nativePath) {
    let module = moduleCache.get(nativePath)

    if (!module) {
      const mapping = opts.map(nativePath)
      module = typeof mapping === 'string'
        ? generateDefaultMapping(mapping)
        : mapping
      moduleCache.set(nativePath, module)

      if (fs.existsSync(nativePath)) {
        fs.copyFileSync(nativePath, module.copyTo)
      } else {
        this.warn(`${TAG} ${nativePath} does not exist`)
      }
    }

    return PREFIX + module.name
  }
}
