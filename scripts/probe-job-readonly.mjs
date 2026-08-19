/**
 * Read-only: fetch one known job JSON (no secrets printed).
 * LOVEMI_PROXY=http://127.0.0.1:7897 LOVEMI_JOB_ID=job_... env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-job-readonly.mjs
 */
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

app.setName('Lovemi Auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))

const PROXY = process.env.LOVEMI_PROXY || 'http://127.0.0.1:7897'
const JOB = process.env.LOVEMI_JOB_ID || ''

function token() {
  const file = path.join(app.getPath('userData'), 'create-char.secrets')
  const raw = fs.readFileSync(file, 'utf8').trim()
  const json = safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(Buffer.from(raw, 'base64'))
    : raw
  return JSON.parse(json).adminSessionToken
}

app.whenReady().then(async () => {
  app.dock?.hide()
  if (!JOB) {
    console.log(JSON.stringify({ ok: false, error: 'set LOVEMI_JOB_ID' }))
    app.exit(1)
    return
  }
  const t = token()
  if (!t) {
    console.log(JSON.stringify({ ok: false, error: 'no admin token' }))
    app.exit(1)
    return
  }
  const res = await undiciFetch(`https://api.lovemi.ai/v1/jobs/${encodeURIComponent(JOB)}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${t}`,
      Origin: 'https://app.lovemi.ai',
      Referer: 'https://app.lovemi.ai/',
    },
    dispatcher: new ProxyAgent(PROXY),
    signal: AbortSignal.timeout(30_000),
  })
  const data = await res.json().catch(() => ({}))
  const pick = {
    ok: res.ok,
    http: res.status,
    job_status: data.status,
    capability_key: data.capability_key,
    job_type: data.job_type,
    public_model_key: data.public_model_key,
    metadata: data.metadata,
    requested_options: data.requested_options,
    keys: Object.keys(data || {}),
    live: data.live,
    result_keys: data.result && typeof data.result === 'object' ? Object.keys(data.result) : null,
    error: data.error || data.message || null,
    snippet: JSON.stringify(data).slice(0, 1200),
  }
  console.log(JSON.stringify(pick, null, 2))
  app.exit(0)
})
