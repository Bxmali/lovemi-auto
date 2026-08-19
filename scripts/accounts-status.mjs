import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

app.setName('lovemi-auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))

app.whenReady().then(() => {
  app.dock?.hide()
  const file = path.join(app.getPath('userData'), 'accounts.enc')
  const buf = fs.readFileSync(file)
  const raw = safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(buf)
    : buf.toString('utf8')
  const accounts = JSON.parse(raw).filter((a) => a && !String(a.id || '').startsWith('demo-'))
  const reg = accounts.filter((a) => a.lovemiRegistered)
  const none = accounts.filter((a) => !a.lovemiRegistered)
  console.log(`total=${accounts.length} registered=${reg.length} unregistered=${none.length}`)
  for (const a of none) {
    console.log(` - ${a.email} | ${a.lovemiRegStatus || 'none'} | ${(a.lovemiRegError || '').slice(0, 80)}`)
  }
  app.exit(0)
})
