# vite-plugin-native

Supports Node/Electron C/C++ native addons. It is a bundle solution based on [Webpack](https://github.com/webpack/webpack).

> Thanks [Erick Zhao](https://github.com/erickzhao) for providing inspiration :)

[![NPM version](https://img.shields.io/npm/v/vite-plugin-native.svg)](https://npmjs.org/package/vite-plugin-native)
[![NPM Downloads](https://img.shields.io/npm/dm/vite-plugin-native.svg)](https://npmjs.org/package/vite-plugin-native)

English | [简体中文](./README.zh-CN.md)

## Install

```bash
npm i -D vite-plugin-native
```

## Usage

```js
import native from 'vite-plugin-native'

export default {
  plugins: [
    native({
      // Enable Webpack
      webpack: {},
    })
  ]
}
```

## API

```ts
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
```

## How to work

> TODO: Translate into English.

See 👉🏻 [工作原理 (How to work)](./README.zh-CN.md#工作原理)
