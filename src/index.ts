import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
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

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

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
const adapter = {
  // 🚨 only fixed code snippets
  // @see - https://github.com/springmeyer/node-addon-example/blob/v0.1.5/index.js#L1-L4
  'node-pre-gyp'(this: PluginContext, code: string, id: string) {
    const regexp = /require\((['"])(@mapbox\/node-pre-gyp|node-pre-gyp)\1\)/
    if (!regexp.test(code)) return

    const node_pre_gyp = loadNpmPkg('@mapbox/node-pre-gyp', id) ?? loadNpmPkg('node-pre-gyp', id)
    if (node_pre_gyp) return

    const libRoot = path.join(path.dirname(id), '..')
    const libPath = node_pre_gyp.find(libRoot, {/* TODO */ })

    const prefixedId = mapAndReturnPrefixedId.call(this, libPath)
    if (prefixedId) {
      return module_exports_binding(prefixedId)
    }
  },
  // 🚨 only fixed code snippets
  // @see - https://github.com/serialport/bindings-cpp/blob/v11.0.1/lib/load-bindings.ts#L1-L6
  'node-gyp-build'(this: PluginContext, code: string, id: string) {
    const regexp = /require\((['"])node-gyp-build\1\)/
    if (!regexp.test(code)) return

    const node_gyp_build = loadNpmPkg('node-gyp-build', id)
    if (node_gyp_build) return

    const libRoot = path.join(path.dirname(id), '..')
    const libPath = node_gyp_build.resolve(libRoot)

    const prefixedId = mapAndReturnPrefixedId.call(this, libPath)
    if (prefixedId) {
      return module_exports_binding(prefixedId)
    }
  },
  // @see - https://github.com/TooTallNate/node-bindings/tree/v1.3.0#example
  'node-bindings'(this: PluginContext, code: string, id: string) {
    const regexp = /require\((['"])bindings\1\)\(\1binding.node\1\)/
    if (!regexp.test(code)) return

    const libPath = bindings.resolve()
    if (!libPath) return

    const prefixedId = mapAndReturnPrefixedId.call(this, libPath)
    if (prefixedId) {
      return module_exports_binding(prefixedId)
    }
  },
  'simple-require'(this: PluginContext, code: string, id: string) {
    const regexp = /require\((['"])(.*\.(node|dll))\1\)/

    const match = code.match(regexp)
    if (!match) return

    const [, , moduleId] = match
    const libPath = path.resolve(id, moduleId)

    const prefixedId = mapAndReturnPrefixedId.call(this, libPath)
    if (prefixedId) {
      return code.replace(moduleId, prefixedId)
    }
  },
}

export default function native(options: NativeOptions = {}): Plugin[] {
  return [
    {
      name: 'vite-plugin-native:resolve',
      enforce: 'pre',
      resolveId(importee, importer) {
        if (importee.startsWith(PREFIX)) return importee

        return mapAndReturnPrefixedId.call(
          this,
          cleanId(importee),
          importer ? cleanId(importer) : importer,
        )
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
      },
      transform(code, id) {
        id = cleanId(id)
        let result: string | undefined

        result ??= adapter['node-pre-gyp'].call(this, code, id)
        result ??= adapter['node-gyp-build'].call(this, code, id)
        result ??= adapter['node-bindings'].call(this, code, id)
        result ??= adapter['simple-require'].call(this, code, id)

        return result
      },
    },
  ]
}

function cleanId(url: string) {
  return cleanUrl(url.startsWith('\0') ? url.replace('\0', '') : url)
}

function loadNpmPkg<T = any>(id: string, root: string): T | undefined {
  let module = loadNpmPkg.cache.get(id)

  if (!module) {
    const node_modules = find_node_modules(root)
    try {
      for (const n_m of node_modules) {
        module = require(path.join(n_m, id))
        break
      }
    } catch { }
  }

  return module
}
loadNpmPkg.cache = new Map<string, any>()

// @see - https://github.com/TooTallNate/node-bindings/blob/v1.3.0/bindings.js#L12-L36
function bindings() { }
bindings.resolve = function bindings_resolve(name = 'binding.node'): string | undefined {
  // TODO: implements
}

function module_exports_binding(prefixedId: string) {
  // Only generate the fixed code snippets and leave the rest to `@rollup/plugin-commonjs`
  // @see - https://github.com/TryGhost/node-sqlite3/blob/v5.1.6/lib/sqlite3-binding.js#L5
  return `const binding = require(${JSON.stringify(prefixedId)});\nmodule.exports = exports = binding;`
}

// ----------------------------------------------------------------------

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

  // Use `export default` instead of `module.exports` can avoid `@rollup/plugin-commonjs` parse :)
  return `export default require(${JSON.stringify(id)});\n`
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

  // 🤔 for resolveId try resolve
  else if (fs.existsSync(resolvedPath + '.node'))
    native = resolvedPath + '.node'
  else if (fs.existsSync(resolvedPath + '.dll'))
    native = resolvedPath + '.dll'

  if (native) {
    let module = moduleCache.get(native)

    if (!module) {
      const mapping = generateDefaultMapping(native)
      module = opts.map(mapping) ?? mapping

      moduleCache.set(native, module) // original
      native = mapping.native
      moduleCache.set(native, module) // user changed

      if (fs.existsSync(native)) {
        fs.copyFileSync(native, module.output) // todo: ensure dir
      } else {
        // Maybe error from the user changes module.native
        this.warn(`${TAG} ${native} does not exist`)
        return
      }
    }

    return PREFIX + module.id
  }
}
