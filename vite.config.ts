import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
// @ts-expect-error vite-plugin-electron/simple typings
import electron from 'vite-plugin-electron/simple'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

/** Keep watermark helpers beside compiled main.js */
function copyWatermarkScript(): Plugin {
  const files = ['watermark_pink.py', 'watermark_text']
  const copy = () => {
    const destDir = path.join(rootDir, 'dist-electron')
    fs.mkdirSync(destDir, { recursive: true })
    for (const name of files) {
      const src = path.join(rootDir, 'electron', name)
      if (!fs.existsSync(src)) continue
      fs.copyFileSync(src, path.join(destDir, name))
      if (name === 'watermark_text') {
        try {
          fs.chmodSync(path.join(destDir, name), 0o755)
        } catch {
          /* ignore */
        }
      }
    }
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
