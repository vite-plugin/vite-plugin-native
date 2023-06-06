import { builtinModules } from 'node:module'
import { defineConfig } from 'vite'
import native from '../..'

export default defineConfig({
  root: __dirname,
  build: {
    minify: false,
    lib: {
      entry: 'main.ts',
      formats: ['cjs'],
      fileName: () => '[name].js',
    },
    rollupOptions: {
      external: [
        'electron',
        'vite',
        ...builtinModules,
        ...builtinModules.map(m => `node:${m}`),
      ],
    },
  },
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
})
