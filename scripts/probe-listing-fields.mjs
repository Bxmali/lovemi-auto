import { app, safeStorage } from 'electron'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

app.setName('Lovemi Auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))
const PROXY = process.env.LOVEMI_PROXY || 'http://127.0.0.1:7890'

app.whenReady().then(async () => {
  app.dock?.hide()
  const db = new DatabaseSync(path.join(app.getPath('userData'), 'accounts.sqlite'))
  let token = ''
  for (const r of db.prepare('SELECT payload FROM accounts').all()) {
    const a = JSON.parse(safeStorage.decryptString(Buffer.from(r.payload, 'base64')))
    if (a.lovemiSessionToken) {
      token = a.lovemiSessionToken
      break
    }
  }
  db.close()
  const url =
    'https://api.lovemi.ai/v1/community-listings?scope=public&listing_type=character_listing&page=1&limit=5&gender_expression=female&character_sort=popular_week'
  const res = await undiciFetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      Origin: 'https://app.lovemi.ai',
      Referer: 'https://app.lovemi.ai/',
    },
    dispatcher: new ProxyAgent(PROXY),
  })
  const data = await res.json()
  const item =
    (data.items || []).find((i) => i.listing_id === 'listing_wIw3a2YNhRclrW1SaQtHzA') ||
    data.items?.[1] ||
    data.items?.[0]

  const walk = (obj, prefix = '', out = []) => {
    if (!obj || typeof obj !== 'object') return out
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k
      if (typeof v === 'string' && (/pubasset_|asset_|listing_/.test(v) || /asset|id/i.test(k))) {
        out.push([p, v.slice(0, 100)])
      } else if (v && typeof v === 'object' && !Array.isArray(v) && prefix.split('.').length < 5) {
        walk(v, p, out)
      } else if (Array.isArray(v) && v[0] && typeof v[0] === 'object' && prefix.split('.').length < 4) {
        walk(v[0], `${p}[0]`, out)
      }
    }
    return out
  }

  // also try detail endpoint variants
  const listingId = item?.listing_id
  const detailPaths = [
    `/v1/community-listings/${listingId}`,
    `/v1/community-listings/${listingId}?include=assets`,
    `/v1/community-listings/${listingId}/assets`,
  ]
  const details = []
  for (const p of detailPaths) {
    const r = await undiciFetch(`https://api.lovemi.ai${p}`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        Origin: 'https://app.lovemi.ai',
        Referer: 'https://app.lovemi.ai/',
      },
      dispatcher: new ProxyAgent(PROXY),
    })
    const t = await r.text()
    let d
    try {
      d = JSON.parse(t)
    } catch {
      d = { raw: t.slice(0, 200) }
    }
    details.push({
      path: p,
      status: r.status,
      keys: d && typeof d === 'object' ? Object.keys(d).slice(0, 25) : [],
      idFields: walk(d).filter((x) => /pubasset|cover_asset|asset_id/.test(x[0] + x[1])).slice(0, 30),
    })
  }

  console.log(
    JSON.stringify(
      {
        listing_id: item?.listing_id,
        cover_asset_id: item?.cover_asset_id,
        engagement: item?.engagement,
        listIdFields: walk(item).slice(0, 80),
        details,
      },
      null,
      2,
    ),
  )
  app.exit(0)
})
