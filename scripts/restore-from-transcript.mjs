import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// 不抢 GUI 的单实例锁：用独立 userData 名会错；改用 requestSingleInstanceLock 前先退出策略
// 直接写入固定路径，不依赖 running GUI
app.setName('lovemi-auto-restore')
const TARGET_DIR = path.join(app.getPath('appData'), 'lovemi-auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto-restore-tmp'))

const TRANSCRIPT = '/Users/tangguoquan/.cursor/projects/Users-tangguoquan-Documents-PycharmProjects-LovemiAuto/agent-transcripts/ba2b86d1-109f-46df-a220-0e46fc1d456e/ba2b86d1-109f-46df-a220-0e46fc1d456e.jsonl'

function parseLine(line) {
  const parts = line.split(':')
  if (parts.length < 4) return null
  const email = parts[0]?.trim()
  if (!email || !email.includes('@')) return null
  return {
    email,
    password: parts[1],
    refreshToken: parts.slice(2, -1).join(':'),
    clientId: parts[parts.length - 1],
  }
}

function extractFromTranscript(raw) {
  const byEmail = new Map()
  // JSONL may escape; also match unescaped
  const re = /([A-Za-z0-9._%+-]+@hotmail\.com:[^\s"'\\]+)/g
  let m
  while ((m = re.exec(raw))) {
    let s = m[1].replace(/\\n.*/, '').replace(/\\+$/, '')
    // strip trailing punctuation that isn't part of token
    s = s.replace(/[,.]+$/, '')
    const p = parseLine(s)
    if (p && p.clientId.length > 8 && p.refreshToken.length > 20) {
      byEmail.set(p.email.toLowerCase(), p)
    }
  }
  return [...byEmail.values()]
}

app.whenReady().then(() => {
  app.dock?.hide()
  try {
    const raw = fs.readFileSync(TRANSCRIPT, 'utf8')
    const parsed = extractFromTranscript(raw)
    console.log('recovered_emails', parsed.length)
    for (const p of parsed) console.log(' +', p.email)
    if (parsed.length < 10) {
      console.error('too few recovered, abort')
      app.exit(2)
      return
    }
    const now = new Date().toISOString()
    const accounts = parsed.map((p) => ({
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
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.pre-restore.bak`)
    if (!safeStorage.isEncryptionAvailable()) {
      console.error('safeStorage unavailable')
      app.exit(3)
      return
    }
    fs.writeFileSync(file, safeStorage.encryptString(JSON.stringify(accounts)))
    console.log('WROTE', file, 'count', accounts.length, 'bytes', fs.statSync(file).size)
    app.exit(0)
  } catch (e) {
    console.error(e)
    app.exit(1)
  }
})
