/**
 * 统计库存：条数 / 已注册 / 有 Lovemi 密码 / 有 Bearer
 */
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
  const withPw = accounts.filter((a) => a.lovemiPassword)
  const withTok = accounts.filter((a) => a.lovemiSessionToken)
  console.log(
    JSON.stringify(
      {
        total: accounts.length,
        registered: reg.length,
        withLovemiPassword: withPw.length,
        withBearer: withTok.length,
        emails: accounts.map((a) => a.email),
      },
      null,
      2,
    ),
  )
  app.exit(0)
})
