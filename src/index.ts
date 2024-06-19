import fs from 'node:fs'
import path from 'node:path'
import {
  type Plugin,
  type UserConfig,
  type Alias,
  normalizePath,
} from 'vite'
import {
  type Configuration,
  validate,
  webpack, // require('webpack').webpack
} from 'webpack'
import { COLOURS } from 'vite-plugin-utils/function'
import type { NodeLoaderOptions, WebpackAssetRelocatorLoader } from './types'
import { createCjs, ensureDir, getInteropSnippet, getNatives } from './utils'

export interface WebpackConfig {
  webpackConfig?: Configuration | ((config: Configuration) => Configuration | undefined | Promise<Configuration | undefined>)
  'node-loader'?: NodeLoaderOptions
  '@vercel/webpack-asset-relocator-loader'?: WebpackAssetRelocatorLoader
}

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
const NativeExt = '.native.js'
const InteropExt = '.interop.js'

export default function native(options: NativeOptions): Plugin {
  const assetsDir = options.assetsDir ??= 'node_natives'
  const nativesMap = new Map<string, {
    built: boolean
    interopFilename: string
  }>
  // Webpack output(absolute path)
  let output: string

  return {
    name: 'vite-plugin-native',
    async config(config) {
      // @see https://github.com/vitejs/vite/blob/v5.3.1/packages/vite/src/node/config.ts#L524-L527
      const resolvedRoot = normalizePath(config.root ? path.resolve(config.root) : process.cwd())
      const outDir = config.build?.outDir ?? 'dist'
      output = normalizePath(path.join(resolvedRoot, outDir, assetsDir))

      const natives = await getNatives(resolvedRoot)
      options.natives ??= natives

      if (typeof options.natives === 'function') {
        options.natives = options.natives(natives)
      }

      const aliases: Alias[] = []
      const withDistAssetBase = (p: string) => (assetsDir && p) ? `${assetsDir}/${p}` : p

      options.natives.length && ensureDir(output)

      for (const native of options.natives) {
        const interopFilename = path.join(output, native + InteropExt)

        aliases.push({
          find: native,
          replacement: interopFilename,
          customResolver(source) {
            const record = nativesMap.get(native)
            if (!record?.built) {
              // Generate Vite and Webpack interop file.
              const code = getInteropSnippet(native, `./${withDistAssetBase(native + NativeExt)}`)
              fs.writeFileSync(interopFilename, code)

              // We did not immediately call the `webpackBundle()` build here 
              // because `build.emptyOutDir = true` will cause the built file to be removed.

              // Collect modules that are explicitly used.
              nativesMap.set(native, { built: false, interopFilename })
            }

            return { id: source }
          },
        })
      }

      const aliasKeys = aliases.map(({ find }) => find as string)

      modifyAlias(config, aliases)
      // Run build are not necessary.
      modifyOptimizeDeps(config, aliasKeys)
    },
    resolveId() {
      // TODO: dynamic detect by bare moduleId. e.g. serialport
    },
    async buildEnd(error) {
      if (error) return

      // Must be explicitly specify use Webpack.
      if (options.webpack) {
        for (const [native, info] of nativesMap) {
          if (info.built) continue

          try {
            await webpackBundle(native, output, options.webpack)
            info.built = true
            fs.rmSync(info.interopFilename, { force: true })
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
  const assetBase = webpackOpts[loader1].outputAssetBase ??= 'native_modules'

  return new Promise<null>(async (resolve, reject) => {
    let options: Configuration = {
      mode: 'none',
      target: 'node14',
      entry: { [name]: name },
      output: {
        library: {
          type: 'commonjs-static',
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
