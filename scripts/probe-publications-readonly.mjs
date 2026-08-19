/**
 * Read-only probe for publication APIs (no secrets printed).
 * LOVEMI_PROXY=http://127.0.0.1:7897 LOVEMI_CHAR_IDS=chr_a,chr_b env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-publications-readonly.mjs
 */
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

app.setName('Lovemi Auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))

const PROXY = process.env.LOVEMI_PROXY || 'http://127.0.0.1:7897'
const API = 'https://api.lovemi.ai'
const CHAR_IDS = (process.env.LOVEMI_CHAR_IDS || 'chr_V6x4xLrXVDMprGim1fb2tw').split(',').filter(Boolean)
const LISTING = process.env.LOVEMI_LISTING_ID || 'listing_9sizy-PEKMZ4ACn3iV5MnA'

function token() {
  const file = path.join(app.getPath('userData'), 'create-char.secrets')
  const raw = fs.readFileSync(file, 'utf8').trim()
  const json = safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(Buffer.from(raw, 'base64'))
    : raw
  return JSON.parse(json).adminSessionToken
}

async function api(method, p) {
  const res = await undiciFetch(`${API}${p}`, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token()}`,
      Origin: 'https://app.lovemi.ai',
      Referer: 'https://app.lovemi.ai/',
      'Accept-Language': 'zh-CN',
    },
    dispatcher: new ProxyAgent(PROXY),
    signal: AbortSignal.timeout(45_000),
  })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = { raw: text.slice(0, 400) }
  }
  return {
    method,
    path: p,
    status: res.status,
    ok: res.ok,
    keys: data && typeof data === 'object' ? Object.keys(data).slice(0, 30) : [],
    data,
  }
}

function slimPub(item) {
  if (!item || typeof item !== 'object') return item
  return {
    keys: Object.keys(item),
    id: item.id || item.publication_id || item.listing_id,
    listing_id: item.listing_id || item.community_listing_id,
    source_object_id: item.source_object_id || item.character_id,
    status: item.status || item.publication_status || item.lifecycle_status,
    listing_type: item.listing_type,
    previewish: Object.keys(item).filter((k) => /preview|motion|video|publish|asset/i.test(k)),
    snippet: JSON.stringify(item).slice(0, 500),
  }
}

app.whenReady().then(async () => {
  app.dock?.hide()
  const ids = CHAR_IDS.slice(0, 8).join(',')
  const pubs = await api(
    'GET',
    `/v1/me/publications?listing_type=character_listing&source_object_type=character&source_object_ids=${encodeURIComponent(ids)}&limit=20`,
  )
  const items = Array.isArray(pubs.data?.items)
    ? pubs.data.items.map(slimPub)
    : Array.isArray(pubs.data)
      ? pubs.data.map(slimPub)
      : []

  const out = {
    pubs: { status: pubs.status, ok: pubs.ok, keys: pubs.keys, itemCount: items.length, items },
    listingGets: [],
  }

  for (const p of [
    `/v1/community-listings/${LISTING}`,
    `/v1/community-listings/${LISTING}/publication-submissions`,
    `/v1/community-listings/${LISTING}/publications`,
    `/v1/me/publications?limit=5`,
    `/v1/me/community-listings?limit=5`,
    `/v1/characters/${CHAR_IDS[0]}`,
  ]) {
    const r = await api('GET', p)
    out.listingGets.push({
      path: p,
      status: r.status,
      ok: r.ok,
      keys: r.keys,
      previewish:
        r.data && typeof r.data === 'object'
          ? Object.keys(r.data).filter((k) => /preview|motion|video|publish|listing/i.test(k))
          : [],
      snippet: JSON.stringify(r.data).slice(0, 600),
    })
  }

  // character fields related to publish
  const ch = out.listingGets.find((x) => x.path.includes('/characters/'))
  console.log(JSON.stringify(out, null, 2))
  app.exit(0)
})
