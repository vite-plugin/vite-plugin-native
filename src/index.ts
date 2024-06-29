import fs from 'node:fs'
import path from 'node:path'
import {
  type Plugin,
  type UserConfig,
  type Alias,
  normalizePath,
} from 'vite'
import type { Configuration } from 'webpack'
import type { NodeLoaderOptions, WebpackAssetRelocatorLoader } from './types'
import { COLOURS } from 'vite-plugin-utils/function'
import { flatDependencies } from 'dependencies-tree'
import {
  type ResolvedNativeRecord,
  createCjs,
  copy,
  ensureDir,
  getInteropSnippet,
  getDependenciesNatives,
  resolveNativeRecord,
} from './utils'

export interface NativeOptions {
  /** @default 'node_natives' */
  assetsDir?: string
  /** 
   * By default native modules are automatically detected if this option is not explicitly configure by the user.
   * @deprecated use `ignore` option instead
   */
  natives?: string[] | ((natives: string[]) => string[])
  /** Ignore the specified native module. */
  ignore?: (name: string) => boolean | undefined
  /** Force copy *.node files to dist/node_modules path if Webpack can't bundle native modules correctly. */
  forceCopyIfUnbuilt?: true
  /** Enable and configure webpack. */
  webpack?: {
    config?: (config: Configuration) => Configuration | undefined | Promise<Configuration | undefined>
    'node-loader'?: NodeLoaderOptions,
    '@vercel/webpack-asset-relocator-loader'?: WebpackAssetRelocatorLoader,
  },
}

const cjs = createCjs(import.meta.url)
const TAG = '[vite-plugin-native]'
const loader1 = '@vercel/webpack-asset-relocator-loader'
const outputAssetBase = 'native_modules'
const NativeExt = '.native.cjs'
const InteropExt = '.interop.mjs'
// `nativesMap` is placed in the global scope and can be effective for multiple builds.
const nativesMap = new Map<string, ResolvedNativeRecord>
// https://github.com/npm/validate-npm-package-name/blob/v5.0.1/lib/index.js#L4
const scopedPackagePattern = /^(?![a-zA-Z]:)[\w@](?!.*:\/\/)/

export default function native(options: NativeOptions): Plugin {
  const assetsDir = options.assetsDir ??= 'node_natives'
  // Webpack output(absolute path)
  let output: string

  return {
    name: 'vite-plugin-native',
    async config(config) {
      // @see https://github.com/vitejs/vite/blob/v5.3.1/packages/vite/src/node/config.ts#L524-L527
      const resolvedRoot = normalizePath(config.root ? path.resolve(config.root) : process.cwd())
      const outDir = config.build?.outDir ?? 'dist'
      output = normalizePath(path.join(resolvedRoot, outDir, assetsDir))

      let nativeRecord = await getDependenciesNatives(resolvedRoot)

      if (options.natives) {
        const natives = Array.isArray(options.natives)
          ? options.natives
          : options.natives([...nativeRecord.keys()])
        // TODO: bundle modules based on `natives`.
      }

      const withDistAssetBase = (p: string) => (assetsDir && p) ? `${assetsDir}/${p}` : p
      const alias: Alias = {
        find: /^(?!(?:\/?@vite\/|\.))(.*)/,
        // Keep `customResolver` receive original source.
        // @see https://github.com/rollup/plugins/blob/alias-v5.1.0/packages/alias/src/index.ts#L92
        replacement: '$1',
        async customResolver(source, importer) {
          if (!importer) return
          if (!scopedPackagePattern.test(source)) return

          if (!nativeRecord.has(source)) {
            // Dynamic deep detection.
            // e.g. serialport -> @serialport/bindings-cpp
            nativeRecord = new Map([...nativeRecord, ...(await resolveNativeRecord(source, importer) ?? [])])
          }

          const nativeItem = nativeRecord.get(source)
          if (!nativeItem) return

          if (options.ignore?.(source) === false) {
            nativeItem.ignore = true
            return
          }

          const nativeFilename = path.join(output, source + NativeExt)
          const interopFilename = path.join(output, source + InteropExt)

          if (!nativesMap.get(source)) {
            ensureDir(path.dirname(interopFilename))

            // Generate Vite and Webpack interop file.
            fs.writeFileSync(
              interopFilename,
              getInteropSnippet(source, `./${withDistAssetBase(source + NativeExt)}`),
            )

            // We did not immediately call the `webpackBundle()` build here 
            // because `build.emptyOutDir = true` will cause the built file to be removed.

            // Collect modules that are explicitly used.
            nativesMap.set(source, {
              status: 'resolved',
              nativeFilename,
              interopFilename,
              native: nativeItem,
            })
          }

          return { id: interopFilename }
        },
      }

      modifyAlias(config, [alias])
      // Run build are not necessary.
      modifyOptimizeDeps(config, [...nativeRecord.keys()])
    },
    async buildEnd(error) {
      if (error) return

      // Must be explicitly specify use Webpack.
      if (options.webpack) {
        for (const item of nativesMap) {
          const [name, native] = item
          if (native.status === 'built') continue
          if (native.native.ignore) continue

          try {
            await webpackBundle(name, output, options.webpack)

            if (options.forceCopyIfUnbuilt) {
              await forceCopyNativeFilesIfUnbuilt(
                native,
                output,
                options.webpack[loader1]?.outputAssetBase ?? outputAssetBase,
              )
            }

            native.status = 'built'
          } catch (error: any) {
            console.error(`\n${TAG}`, error)
            process.exit(1)
          }
        }
      }
    },
  }
}

function modifyAlias(config: UserConfig, aliases: Alias[]) {
  config.resolve ??= {}
  config.resolve.alias ??= []
  if (Object.prototype.toString.call(config.resolve.alias) === '[object Object]') {
    config.resolve.alias = Object
      .entries(config.resolve.alias)
      .reduce<Alias[]>((memo, [find, replacement]) => memo.concat({ find, replacement }), [])
  }
  const aliasArray = config.resolve.alias as Alias[]
  // Using Array.push can ensure that user config has a higher priority
  // @see https://github.com/rollup/plugins/blob/alias-v5.1.0/packages/alias/src/index.ts#L86
  aliasArray.push(...aliases)
}

function modifyOptimizeDeps(config: UserConfig, exclude: string[]) {
  config.optimizeDeps ??= {}
  config.optimizeDeps.exclude ??= []
  for (const str of exclude) {
    if (!config.optimizeDeps.exclude.includes(str)) {
      // Avoid Vite secondary pre-bundle
      config.optimizeDeps.exclude.push(str)
    }
  }
}

async function webpackBundle(
  name: string,
  output: string,
  webpackOpts: NonNullable<NativeOptions['webpack']>
) {
  webpackOpts[loader1] ??= {}
  const { validate, webpack } = cjs.require('webpack') as typeof import('webpack')
  const assetBase = webpackOpts[loader1].outputAssetBase ??= outputAssetBase

  return new Promise<null>(async (resolve, reject) => {
    let options: Configuration = {
      mode: 'none',
      target: 'node14',
      entry: { [name]: name },
      output: {
        library: {
          type: 'commonjs2',
        },
        path: output,
        filename: '[name]' + NativeExt,
      },
      module: {
        // @see https://github.com/electron/forge/blob/v7.4.0/packages/template/webpack-typescript/tmpl/webpack.rules.ts
        rules: [
          // Add support for native node modules
          {
            // We're specifying native_modules in the test because the asset relocator loader generates a
            // "fake" .node file which is really a cjs file.
            test: new RegExp(`${assetBase}[/\\\\].+\\.node$`),
            use: {
              loader: cjs.require.resolve('node-loader'),
              options: webpackOpts['node-loader'],
            },
          },
          {
            test: /[/\\]node_modules[/\\].+\.(m?js|node)$/,
            parser: { amd: false },
            use: {
              loader: cjs.require.resolve('@vercel/webpack-asset-relocator-loader'),
              options: webpackOpts[loader1],
            },
          },
        ],
      },
    }

    if (webpackOpts.config) {
      options = await webpackOpts.config(options) ?? options
    }

    try {
      validate(options)
    } catch (error: any) {
      reject(COLOURS.red(error.message))
      return
    }

    webpack(options).run((error, stats) => {
      if (error) {
        reject(error)
        return
      }

      if (stats?.hasErrors()) {
        const errorMsg = stats.toJson().errors?.map(msg => msg.message).join('\n')

        if (errorMsg) {
          reject(COLOURS.red(errorMsg))
          return
        }
      }

      console.log(`${TAG}`, name, COLOURS.green('build success'))
      resolve(null)
    })
  })
}

// Force copy *.node files to dist/node_modules path if Webpack can't bundle native modules correctly.
async function forceCopyNativeFilesIfUnbuilt(
  resolvedNative: ResolvedNativeRecord,
  output: string,
  assetBase: string,
) {
  const { nativeFilename } = resolvedNative
  const { name: nativeName, path: nativeRoot, nativeFiles } = resolvedNative.native
  const nativeOutput = path.posix.join(output, assetBase)
  const nativeNodeModules = path.posix.join(output, 'node_modules')
  const exists = nativeFiles
    // e.g. ['build/Release/better_sqlite3.node', 'build/Release/test_extension.node']
    .some((file) => fs.existsSync(path.join(nativeOutput, file)))

  if (!exists) {
    const nativeDest = path.join(nativeNodeModules, nativeName)
    copy(nativeRoot, nativeDest)

    const dependencies = await flatDependencies(nativeRoot)
    for (const dep of dependencies) {
      copy(dep.src, path.join(nativeNodeModules, dep.name))
    }

    let relativePath = path.posix.relative(path.dirname(nativeFilename), nativeDest)
    if (!relativePath.startsWith('.')) {
      relativePath = `./${relativePath}`
    }
    fs.writeFileSync(
      path.join(nativeFilename),
      `
// This is a native module that cannot be built correctly.
module.exports = require("${relativePath}");
`.trim(),
    )
  }
}
