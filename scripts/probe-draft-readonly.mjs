/**
 * Read-only: probe publication draft + draft-assets (no secrets printed).
 * LOVEMI_PROXY=http://127.0.0.1:7897 LOVEMI_CHAR_ID=chr_... env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-draft-readonly.mjs
 */
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

app.setName('Lovemi Auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))

const PROXY = process.env.LOVEMI_PROXY || 'http://127.0.0.1:7897'
const API = 'https://api.lovemi.ai'
const CHAR = process.env.LOVEMI_CHAR_ID || 'chr_RP69-2pjhJkbpeJM3rrLmQ'
const LISTING = process.env.LOVEMI_LISTING_ID || 'listing_9sizy-PEKMZ4ACn3iV5MnA'

function token() {
  const file = path.join(app.getPath('userData'), 'create-char.secrets')
  const raw = fs.readFileSync(file, 'utf8').trim()
  const json = safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(Buffer.from(raw, 'base64'))
    : raw
  return JSON.parse(json).adminSessionToken
}

async function api(method, p, body) {
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${token()}`,
    Origin: 'https://app.lovemi.ai',
    Referer: 'https://app.lovemi.ai/',
    'Accept-Language': 'zh-CN',
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await undiciFetch(`${API}${p}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    dispatcher: new ProxyAgent(PROXY),
    signal: AbortSignal.timeout(45_000),
  })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = { raw: text.slice(0, 500) }
  }
  return {
    method,
    path: p,
    status: res.status,
    allow: res.headers.get('allow'),
    ok: res.ok,
    keys: data && typeof data === 'object' ? Object.keys(data).slice(0, 40) : [],
    snippet: JSON.stringify(data).slice(0, 700),
  }
}

app.whenReady().then(async () => {
  app.dock?.hide()
  const out = []
  const draftPath = `/v1/me/publications/by-source/character/${CHAR}/draft`
  for (const m of ['GET', 'OPTIONS', 'HEAD']) out.push(await api(m, draftPath))
  out.push(await api('GET', `/v1/characters/${CHAR}/assets?scope=active`))
  out.push(await api('GET', `/v1/community-listings/${LISTING}/draft-assets`))
  out.push(await api('OPTIONS', `/v1/community-listings/${LISTING}/draft-assets`))
  out.push(await api('GET', `/v1/me/publications/by-source/character/${CHAR}`))
  out.push(
    await api(
      'GET',
      `/v1/me/publications?listing_type=character_listing&source_object_type=character&source_object_ids=${CHAR}&limit=5`,
    ),
  )
  console.log(JSON.stringify({ char: CHAR, listing: LISTING, probes: out }, null, 2))
  app.exit(0)
})
