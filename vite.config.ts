import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
// @ts-expect-error vite-plugin-electron/simple typings
import electron from 'vite-plugin-electron/simple'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

/** Keep watermark_pink.py beside compiled main.js */
function copyWatermarkScript(): Plugin {
  const src = path.join(rootDir, 'electron', 'watermark_pink.py')
  const dest = path.join(rootDir, 'dist-electron', 'watermark_pink.py')
  const copy = () => {
    if (!fs.existsSync(src)) return
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
  }
  return {
    name: 'copy-watermark-pink',
    buildStart: copy,
    writeBundle: copy,
    configureServer() {
      copy()
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    copyWatermarkScript(),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: {
          plugins: [copyWatermarkScript()],
          build: {
            rollupOptions: {
              external: ['electron', 'undici', 'node:sqlite'],
            },
          },
        },
      },
      preload: {
        input: path.join(rootDir, 'electron/preload.ts'),
        vite: {
          build: {
            rollupOptions: {
              external: ['electron', 'undici', 'node:sqlite'],
            },
          },
        },
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(rootDir, 'src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
