/**
 * Probe short-video explore API (no secrets printed).
 * LOVEMI_PROXY=http://127.0.0.1:7897 env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-explore-video.mjs
 */
import { app, safeStorage } from 'electron'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

app.setName('Lovemi Auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))

const PROXY = process.env.LOVEMI_PROXY || 'http://127.0.0.1:7897'
const PATH = '/v1/community/explore?sort=recommended&media=video&limit=20'

function summarizeItem(item) {
  if (!item || typeof item !== 'object') return { type: typeof item }
  const keys = Object.keys(item).slice(0, 24)
  const listingId = item.listing_id || item.id || item.listingId
  const assetId =
    item.asset_id ||
    item.engagement?.asset_id ||
    item.preview_assets?.[0]?.asset_id ||
    item.media?.asset_id ||
    item.video?.asset_id
  const title =
    item.title ||
    item.characters?.[0]?.display_name ||
    item.characters?.[0]?.name ||
    item.caption ||
    null
  const mediaType = item.media_type || item.media || item.type || null
  return {
    keys,
    listingId: listingId ? String(listingId).slice(0, 48) : null,
    assetId: assetId ? String(assetId).slice(0, 48) : null,
    title: title ? String(title).slice(0, 40) : null,
    mediaType: mediaType ? String(mediaType).slice(0, 32) : null,
  }
}

app.whenReady().then(async () => {
  app.dock?.hide()
  try {
    const db = new DatabaseSync(path.join(app.getPath('userData'), 'accounts.sqlite'))
    let emailLocal = ''
    let token = ''
    for (const r of db.prepare('SELECT payload FROM accounts').all()) {
      const a = JSON.parse(safeStorage.decryptString(Buffer.from(r.payload, 'base64')))
      if (a.lovemiSessionToken) {
        emailLocal = String(a.email || '').split('@')[0]
        token = a.lovemiSessionToken
        break
      }
    }
    db.close()
    if (!token) {
      console.log(JSON.stringify({ ok: false, error: 'no bearer in stock' }))
      app.exit(1)
      return
    }

    const url = `https://api.lovemi.ai${PATH}`
    const res = await undiciFetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'zh-CN',
        Authorization: `Bearer ${token}`,
        Origin: 'https://app.lovemi.ai',
        Referer: 'https://app.lovemi.ai/',
      },
      dispatcher: new ProxyAgent(PROXY),
      signal: AbortSignal.timeout(25_000),
    })
    const data = await res.json().catch(() => ({}))
    const topKeys = data && typeof data === 'object' ? Object.keys(data) : []
    const items = Array.isArray(data.items)
      ? data.items
      : Array.isArray(data.results)
        ? data.results
        : Array.isArray(data.data)
          ? data.data
          : Array.isArray(data)
            ? data
            : []
    const sample = items.slice(0, 3).map(summarizeItem)
    console.log(
      JSON.stringify(
        {
          ok: res.ok,
          status: res.status,
          proxy: PROXY,
          path: PATH,
          viaAccount: emailLocal,
          rateLimitRemaining: res.headers.get('x-ratelimit-remaining'),
          rateLimitPolicy: res.headers.get('x-ratelimit-policy'),
          topKeys,
          itemCount: items.length,
          sample,
          error:
            res.ok
              ? undefined
              : data.message || data.error || data.error_code || `HTTP ${res.status}`,
        },
        null,
        2,
      ),
    )
    app.exit(res.ok ? 0 : 1)
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }))
    app.exit(1)
  }
})
