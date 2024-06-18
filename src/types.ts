/** @see https://github.com/webpack-contrib/node-loader/tree/v2.0.0?tab=readme-ov-file#options */
export interface NodeLoaderOptions {
  /**
   * The flags argument is an integer that allows to specify dlopen behavior. See the [process.dlopen](https://nodejs.org/api/process.html#process_process_dlopen_module_filename_flags) documentation for details.
   */
  flags?: number
  /**
   * Specifies a custom filename template for the target file(s).
   * @default '[contenthash].[ext]'
   */
  name?: string
}

/** @see https://github.com/vercel/webpack-asset-relocator-loader/tree/v1.7.4?tab=readme-ov-file#usage-1 */
export interface WebpackAssetRelocatorLoader {
  /**
   * optional, base folder for asset emission (eg assets/name.ext)
   * @default 'assets'
   */
  outputAssetBase?: string
  /**
   * optional, restrict asset emissions to only the given folder.
   * @default process.cwd()
   */
  filterAssetBase?: string
  /**
   * optional, permit entire __dirname emission  
   * eg `const nonAnalyzable = __dirname` can emit everything in the folder
   * 
   * @default false
   */
  emitDirnameAll?: boolean
  /**
   * optional, permit entire filterAssetBase emission  
   * eg `const nonAnalyzable = process.cwd()` can emit everything in the cwd()
   * 
   * @default false
   */
  emitFilterAssetBaseAll?: boolean
  /**
   * optional, custom functional asset emitter  
   * takes an asset path and returns the replacement  
   * or returns false to skip emission  
   */
  customEmit?: (path: string, opts: { id: string; isRequire: boolean }) => false | '"./custom-replacement"' | string
  /**
   * optional, a list of asset names already emitted or  
   * defined that should not be emitted
   */
  existingAssetNames?: string[]
  /**
   * @default false
   */
  wrapperCompatibility?: boolean
  /**
   * build for process.env.NODE_ENV = 'production'
   */
  production?: boolean
  /**
   * @default process.cwd()
   */
  cwd?: string
  /**
   * @default false
   */
  debugLog?: boolean
}
