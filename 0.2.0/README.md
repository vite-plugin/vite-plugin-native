# vite-plugin-native

Plugin for Node native extensions. The project is inspired by the [rollup-plugin-natives](https://github.com/danielgindi/rollup-plugin-natives)

[![NPM version](https://img.shields.io/npm/v/vite-plugin-native.svg)](https://npmjs.org/package/vite-plugin-native)
[![NPM Downloads](https://img.shields.io/npm/dm/vite-plugin-native.svg)](https://npmjs.org/package/vite-plugin-native)

- ✅ [@mapbox/node-pre-gyp](https://github.com/mapbox/node-pre-gyp)
- ✅ [node-gyp-build](https://github.com/prebuild/node-gyp-build)
- ✅ Cross-platform cross-compile
## Install

```bash
npm i vite-plugin-native -D
```

## Usage

```javascript
import native from 'vite-plugin-native'

export default {
  plugins: [
    native(/* options */)
  ]
}
```

## API

```ts
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
```

## Advanced

Three advanced uses are described in the code comments

```ts
import native from 'vite-plugin-native'

export default {
  plugins: [
    native({
      map(mapping) {
        // 🚨 If you want to cross-compile across platforms, you can change the path to `mapping.native` to do so

        // 🚨 If your `build.outDir` is not `dist`, you may need to dynamically adjust the value of `mapping.id` to fit it

        // 🚨 Avoid named conflict
        if (mapping.native.includes('serialport')) {
          mapping.id = mapping.id.replace('node.napi', 'node_serialport.napi')
          mapping.output = mapping.output.replace('node.napi', 'node_serialport.napi')
        }
        return mapping
      },
    }),
  ],
}
```
