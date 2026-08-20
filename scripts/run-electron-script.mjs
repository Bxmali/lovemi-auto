/**
 * Windows-safe launcher: unset ELECTRON_RUN_AS_NODE then run Electron script.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

delete process.env.ELECTRON_RUN_AS_NODE

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = path.join(
  root,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
)
const script = process.argv[2]
if (!script) {
  console.error('usage: node scripts/run-electron-script.mjs <script.cjs>')
  process.exit(1)
}
const child = spawn(electronBin, [path.resolve(root, script), ...process.argv.slice(3)], {
  stdio: 'inherit',
  env: process.env,
  cwd: root,
})
child.on('exit', (code) => process.exit(code ?? 1))
