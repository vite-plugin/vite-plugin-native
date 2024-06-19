import fs from 'node:fs'
import path from 'node:path'
import { builtinModules } from 'node:module'
import { defineConfig } from 'vite'
import native from '../..'

fs.rmSync(path.join(__dirname, 'dist'), { recursive: true, force: true })

export default defineConfig({
  root: __dirname,
  build: {
    minify: false,
    emptyOutDir: false,
    lib: {
      entry: 'main.ts',
      formats: ['cjs'],
      fileName: () => '[name].js',
    },
    rollupOptions: {
      external: [
        'vite',
        ...builtinModules,
        ...builtinModules.map(m => `node:${m}`),
      ],
    },
  },
  plugins: [
    native({
      natives: (names) => names.concat('serialport'),
      webpack: {},
    }),
  ],
})
