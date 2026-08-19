import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

app.setName('Lovemi Auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))

app.whenReady().then(() => {
  app.dock?.hide()
  const expect = process.env.EXPECT_BEARER || ''
  const file = path.join(app.getPath('userData'), 'create-char.secrets')
  try {
    const raw = fs.readFileSync(file, 'utf8').trim()
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(raw, 'base64'))
      : raw
    const s = JSON.parse(json)
    const t = String(s.adminSessionToken || '')
    const matched = Boolean(expect) && t === expect
    console.log(
      JSON.stringify({
        matched,
        hasAdminToken: Boolean(t),
        tokenLen: t.length,
        fingerprint: t ? createHash('sha256').update(t).digest('hex').slice(0, 10) : '',
        expectFp: expect ? createHash('sha256').update(expect).digest('hex').slice(0, 10) : '',
      }),
    )
    app.exit(matched || !expect ? 0 : 2)
  } catch (e) {
    console.log(JSON.stringify({ matched: false, error: String(e.message || e) }))
    app.exit(1)
  }
})
