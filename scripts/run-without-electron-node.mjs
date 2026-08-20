/**
 * Cross-platform replacement for `env -u ELECTRON_RUN_AS_NODE vite …`
 * npm/npx may set ELECTRON_RUN_AS_NODE, which makes Electron behave like Node.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

delete process.env.ELECTRON_RUN_AS_NODE

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const viteJs = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
const child = spawn(process.execPath, [viteJs, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
  cwd: root,
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})
