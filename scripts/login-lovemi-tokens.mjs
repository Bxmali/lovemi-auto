/**
 * 登录取 Bearer 并写回库存（串行，可限流退避）
 * LOVEMI_PROXY=http://127.0.0.1:7890 LOVEMI_LIMIT=15 env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/login-lovemi-tokens.mjs
 */
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

app.setName('lovemi-auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))

const PROXY = process.env.LOVEMI_PROXY || 'http://127.0.0.1:7890'
const LIMIT = Math.max(1, Number(process.env.LOVEMI_LIMIT || '15'))
const API = 'https://api.lovemi.ai'

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function login(email, password) {
  const res = await undiciFetch(`${API}/v1/auth/password/sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, password }),
    dispatcher: new ProxyAgent(PROXY),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.session_token) {
    return { ok: false, error: data.message || data.error || data.error_code || `HTTP ${res.status}` }
  }
  return {
    ok: true,
    sessionToken: String(data.session_token),
    userId: data.user_id ? String(data.user_id) : undefined,
  }
}

app.whenReady().then(async () => {
  app.dock?.hide()
  try {
    const file = path.join(app.getPath('userData'), 'accounts.enc')
    const accounts = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)))
    const targets = accounts
      .filter((a) => a.lovemiRegistered && a.lovemiPassword && !a.lovemiSessionToken)
      .slice(0, LIMIT)
    console.log(`proxy=${PROXY} targets=${targets.length}`)
    let ok = 0
    let fail = 0
    for (const a of targets) {
      console.log(`→ ${a.email}`)
      let r = await login(a.email, a.lovemiPassword)
      if (!r.ok && /too many|rate|429/i.test(r.error || '')) {
        console.log('  rate-limit, wait 15s')
        await sleep(15_000)
        r = await login(a.email, a.lovemiPassword)
      }
      if (r.ok) {
        a.lovemiSessionToken = r.sessionToken
        a.lovemiUserId = r.userId
        a.lovemiTokenAt = new Date().toISOString()
        console.log('  OK token')
        ok++
      } else {
        console.log(`  FAIL ${r.error}`)
        fail++
      }
      await sleep(3500)
    }
    fs.writeFileSync(file, safeStorage.encryptString(JSON.stringify(accounts)))
    console.log(`done ok=${ok} fail=${fail}`)
    app.exit(0)
  } catch (e) {
    console.error(e)
    app.exit(1)
  }
})
