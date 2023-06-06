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
    native(),
  ],
})
