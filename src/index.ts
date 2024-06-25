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
import {
  type NativeRecord,
  type NativeRecordType,
  createCjs,
  ensureDir,
  getInteropSnippet,
  getDependenciesNatives,
  resolveNativeRecord,
} from './utils'

export interface NativeOptions {
  /** @default 'node_natives' */
  assetsDir?: string
  /** By default native modules are automatically detected if this option is not explicitly configure by the user. */
  natives?: string[] | ((natives: string[]) => string[])
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
const NativeExt = '.native.cjs'
const InteropExt = '.interop.mjs'
// https://github.com/vitejs/vite/blob/v5.3.1/packages/vite/src/node/plugins/index.ts#L55
const bareImportRE = /^(?![a-zA-Z]:)[\w@](?!.*:\/\/)/
// `nativesMap` is placed in the global scope and can be effective for multiple builds.
const nativesMap = new Map<string, {
  status: 'built' | 'resolved'
  nativeFilename: string
  interopFilename: string
  type: NativeRecordType
  nodeFiles: string[]
}>

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

      const depsNativeRecord = await getDependenciesNatives(resolvedRoot)
      const depsNatives = [...depsNativeRecord.keys()]

      if (options.natives) {
        const natives = Array.isArray(options.natives)
          ? options.natives
          : options.natives(depsNatives)
        // TODO: bundle modules based on `natives`.
      }

      const withDistAssetBase = (p: string) => (assetsDir && p) ? `${assetsDir}/${p}` : p

      let detectedNativeRecord: NativeRecord = new Map
      let detectedNatives: string[] = []

      const alias: Alias = {
        find: /(.*)/,
        // Keep `customResolver` receive original source.
        // @see https://github.com/rollup/plugins/blob/alias-v5.1.0/packages/alias/src/index.ts#L92
        replacement: '$1',
        async customResolver(source, importer) {
          if (!importer) return
          if (!bareImportRE.test(source)) return

          if (!depsNativeRecord.has(source)) {
            // Auto detection.
            // e.g. serialport -> @serialport/bindings-cpp
            const nativeRecord = await resolveNativeRecord(source, importer)
            if (nativeRecord) {
              detectedNativeRecord = new Map([...detectedNativeRecord, ...nativeRecord])
              detectedNatives = [...depsNativeRecord.keys()]
            }
          }

          if ([...depsNatives, ...detectedNatives].includes(source)) {
            const nativeFilename = path.join(output, source + NativeExt)
            const interopFilename = path.join(output, source + InteropExt)

            if (!nativesMap.get(source)) {
              ensureDir(output)

              // Generate Vite and Webpack interop file.
              fs.writeFileSync(
                interopFilename,
                getInteropSnippet(source, `./${withDistAssetBase(source + NativeExt)}`),
              )

              // We did not immediately call the `webpackBundle()` build here 
              // because `build.emptyOutDir = true` will cause the built file to be removed.

              const isDetected = detectedNativeRecord.has(source)

              // Collect modules that are explicitly used.
              nativesMap.set(source, {
                status: 'resolved',
                nativeFilename,
                interopFilename,
                type: isDetected ? 'detected' : 'dependencies',
                nodeFiles: isDetected
                  ? detectedNativeRecord.get(source)?.nativeFiles!
                  : depsNativeRecord.get(source)?.nativeFiles!,
              })
            }

            return { id: interopFilename }
          }
        },
      }

      modifyAlias(config, [alias])
      // Run build are not necessary.
      modifyOptimizeDeps(config, [...depsNatives, ...detectedNatives])
    },
    async buildEnd(error) {
      if (error) return

      // Must be explicitly specify use Webpack.
      if (options.webpack) {
        for (const [native, info] of nativesMap) {
          if (info.status === 'built') continue

          try {
            await webpackBundle(native, output, options.webpack)
            // TODO: force copy *.node files to dist/node_modules path if Webpack can't bundle it correctly.
            info.status = 'built'
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
  const assetBase = webpackOpts[loader1].outputAssetBase ??= 'native_modules'

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
