import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

app.setName('lovemi-auto-restore')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto-restore-tmp'))
const TARGET_DIR = path.join(app.getPath('appData'), 'lovemi-auto')
const LINES = path.join(path.dirname(new URL(import.meta.url).pathname), '_restore_lines.txt')

function parseLine(line) {
  const parts = line.trim().split(':')
  if (parts.length < 4) return null
  return {
    email: parts[0],
    password: parts[1],
    refreshToken: parts.slice(2, -1).join(':'),
    clientId: parts[parts.length - 1],
  }
}

app.whenReady().then(() => {
  app.dock?.hide()
  try {
    const rows = fs.readFileSync(LINES, 'utf8').split(/\r?\n/).map(parseLine).filter(Boolean)
    console.log('rows', rows.length)
    const now = new Date().toISOString()
    const accounts = rows.map((p) => ({
      id: crypto.randomUUID(),
      email: p.email,
      authMode: 'oauth_graph',
      password: p.password,
      refreshToken: p.refreshToken,
      clientId: p.clientId,
      labels: [],
      status: 'idle',
      notes: 'restored-from-chat-history',
      createdAt: now,
      lovemiRegistered: true,
      lovemiRegStatus: 'registered',
      lovemiRegisteredAt: now,
    }))
    fs.mkdirSync(TARGET_DIR, { recursive: true })
    const file = path.join(TARGET_DIR, 'accounts.enc')
    if (fs.existsSync(file) && fs.statSync(file).size > 64) {
      fs.copyFileSync(file, `${file}.pre-restore.bak`)
    }
    fs.writeFileSync(file, safeStorage.encryptString(JSON.stringify(accounts)))
    console.log('WROTE', file, 'count', accounts.length, 'bytes', fs.statSync(file).size)
    // verify decrypt
    const back = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)))
    console.log('VERIFY', back.length, back.map((a) => a.email).join(','))
    app.exit(0)
  } catch (e) {
    console.error(e)
    app.exit(1)
  }
})
