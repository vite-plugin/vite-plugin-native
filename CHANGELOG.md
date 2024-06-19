## 2.0.0 (2023-06-20)

**Break**. This will be a completely new version.

Due to the bundling format of Vite (Rollup), it is not suitable to build a pure js module. It happens that a C/C++ native module can only be a cjs module. So this new version will use Webpack for pre-bundle. It behaves really similar to Vite's own [Dependency Pre-Bundling](https://vitejs.dev/guide/dep-pre-bundling.html#dependency-pre-bundling).
Thanks to [Erick Zhao](https://github.com/erickzhao) for the inspiration.

- Supports Electron/Node
- Compatible [Electron Forge](https://github.com/electron/forge) and [
Electron⚡️Vite](https://github.com/electron-vite)

#### [How to work](https://github.com/vite-plugin/vite-plugin-native/blob/v2.0.0/README.md#how-to-work)

## 0.2.0 (2023-06-07)

- 8127327 feat: support `node-bindings`
- 2edcb31 refactor: better logic
- bd3e000 log: update

## 0.1.0 (2023-06-06)

- 71028d7 feat(test): support `serialport`
- 7fd4b46 feat: support `node-gyp-build`, e.g. `serialport`
- b27844d feat(test): support `sqlite3`
- 1f0c43f refactor(0.1.0-beta.1): re-design API
- 9c58b4f v0.1.0
- 009edec Initial commit
