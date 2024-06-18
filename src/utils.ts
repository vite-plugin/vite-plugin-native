import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { AssetInfo, Compiler, WebpackPluginInstance } from 'webpack'
import glob from 'fast-glob'
import libEsm from 'lib-esm'
import { node_modules as findNodeModules } from 'vite-plugin-utils/function'

const cjs = createCjs(import.meta.url)

export function createCjs(url = import.meta.url) {
  const cjs__filename = typeof __filename === 'undefined'
    ? fileURLToPath(url)
    : __filename
  const cjs__dirname = path.dirname(cjs__filename)
  const cjsRequire = typeof require === 'undefined'
    ? createRequire(url)
    : require

  return {
    __filename: cjs__filename,
    __dirname: cjs__dirname,
    require: cjsRequire,
  }
}

export async function getNatives(root = process.cwd()) {
  const node_modules_paths = findNodeModules(root)
  // Native modules of package.json
  const natives = []

  for (const node_modules_path of node_modules_paths) {
    const pkgId = path.join(node_modules_path, '../package.json')
    if (fs.existsSync(pkgId)) {
      const pkg = cjs.require(pkgId)
      // Resolve package.json dependencies and devDependencies
      const deps = Object.keys(pkg.dependencies || {}).concat(Object.keys(pkg.devDependencies || {}))

      for (const dep of deps) {
        const depPath = path.join(node_modules_path, dep)
        // @see https://github.com/electron/forge/blob/v7.4.0/packages/plugin/webpack/src/WebpackPlugin.ts#L192
        const nativeFiles = await glob('**/*.node', { cwd: depPath })

        if (nativeFiles.length) {
          natives.push(dep)
        }
      }
    }
  }

  return natives
}

export class OnBuildDone implements WebpackPluginInstance {
  name = 'vite-plugin-native'

  constructor(
    public options: {
      name: string
      callback: (assets: Map<string, AssetInfo>) => void
    }
  ) { }

  apply(compiler: Compiler) {
    compiler.hooks.afterDone.tap(`${this.name}:build-done`, (stats) => {
      this.options.callback(stats.compilation.assetsInfo)
    })
  }
}

export function getInteropSnippet(name: string, id: string) {
  const snippet = libEsm({
    exports: Object.getOwnPropertyNames(cjs.require(name)),
  })

  // `cjsRequire` can be avoid `esbuild.build`, `@rollup/plugin-commonjs`
  return `
import { createRequire } from "module";
const cjsRequire = createRequire(import.meta.url);
const _M_ = cjsRequire("${id}");
${snippet.exports}
`
}
