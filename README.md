# vite-plugin-native

Plugin for Node native extensions. The project is inspired by the [rollup-plugin-natives](https://github.com/danielgindi/rollup-plugin-natives)

[![NPM version](https://img.shields.io/npm/v/vite-plugin-native.svg)](https://npmjs.org/package/vite-plugin-native)
[![NPM Downloads](https://img.shields.io/npm/dm/vite-plugin-native.svg)](https://npmjs.org/package/vite-plugin-native)

- ✅ Support Node.js, Electron

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
```

## TODO

- [ ] write test
