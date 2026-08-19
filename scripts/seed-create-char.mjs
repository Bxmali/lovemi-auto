/**
 * Seed create-char secrets into userData (encrypted). Never prints secret values.
 * LOVEMI_TEAMO_KEY=... LOVEMI_ADMIN_BEARER=... env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/seed-create-char.mjs
 */
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

app.setName('Lovemi Auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))

app.whenReady().then(() => {
  app.dock?.hide()
  const file = path.join(app.getPath('userData'), 'create-char.secrets')
  let prev = {}
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8').trim()
      const json = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(Buffer.from(raw, 'base64'))
        : raw
      prev = JSON.parse(json)
    }
  } catch {
    prev = {}
  }
  const key = process.env.LOVEMI_TEAMO_KEY || ''
  const bearer = process.env.LOVEMI_ADMIN_BEARER || ''
  if (!key && !bearer) {
    console.log(JSON.stringify({ ok: false, error: 'set LOVEMI_TEAMO_KEY and/or LOVEMI_ADMIN_BEARER' }))
    app.exit(1)
    return
  }
  const next = {
    teamoApiBase: process.env.LOVEMI_TEAMO_BASE || prev.teamoApiBase || 'https://api.teamorouter.com/v1',
    teamoModel: process.env.LOVEMI_TEAMO_MODEL || prev.teamoModel || 'gpt-5.4-mini',
    teamoApiKey: key || prev.teamoApiKey || '',
    adminSessionToken: bearer || prev.adminSessionToken || '',
    adminEmailLocal: process.env.LOVEMI_ADMIN_EMAIL_LOCAL || prev.adminEmailLocal || '',
    adminAccountId: prev.adminAccountId || '',
  }
  const payload = JSON.stringify(next)
  const out = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(payload).toString('base64')
    : payload
  fs.writeFileSync(file, out, 'utf8')
  console.log(
    JSON.stringify({
      ok: true,
      hasApiKey: Boolean(next.teamoApiKey),
      hasAdminToken: Boolean(next.adminSessionToken),
      teamoModel: next.teamoModel,
      teamoApiBase: next.teamoApiBase,
    }),
  )
  app.exit(0)
})
