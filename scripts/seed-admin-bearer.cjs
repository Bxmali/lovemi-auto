/**
 * 本机一次性写入管理员 Bearer（加密到 create-char.secrets）
 * 用法:
 *   LOVEMI_ADMIN_BEARER='你的token' env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/seed-admin-bearer.cjs
 */
const { app, safeStorage } = require('electron')
const fs = require('fs')
const path = require('path')

const TOKEN = String(process.env.LOVEMI_ADMIN_BEARER || '')
  .replace(/^Bearer\s+/i, '')
  .trim()

if (!TOKEN) {
  console.error('缺少 LOVEMI_ADMIN_BEARER')
  process.exit(1)
}

app.setName('lovemi-auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))

app.whenReady().then(() => {
  const file = path.join(app.getPath('userData'), 'create-char.secrets')
  let cur = {
    teamoApiBase: 'https://api.teamorouter.com/v1',
    teamoApiKey: '',
    teamoModel: 'gpt-5.4-mini',
  }
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8').trim()
    try {
      const json = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(Buffer.from(raw, 'base64'))
        : raw
      cur = { ...cur, ...JSON.parse(json) }
    } catch {
      /* keep defaults */
    }
  }
  const next = {
    ...cur,
    adminSessionToken: TOKEN,
    adminEmailLocal: cur.adminEmailLocal || 'Lumi Vale',
  }
  const json = JSON.stringify(next)
  const payload = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json).toString('base64')
    : json
  fs.writeFileSync(file, payload, 'utf8')
  console.log(
    JSON.stringify({
      ok: true,
      path: file,
      tokenLen: TOKEN.length,
      tokenPrefix: TOKEN.slice(0, 8),
      hasApiKey: Boolean(next.teamoApiKey),
      downloadsDir: next.downloadsDir || null,
    }),
  )
  app.exit(0)
})
