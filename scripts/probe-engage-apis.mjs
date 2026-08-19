/**
 * 探测发现条目结构 + creator-profile；可选试赞/试评（LOVEMI_DRY=1 默认只读）
 * LOVEMI_PROXY=http://127.0.0.1:7890 LOVEMI_DRY=1 env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-engage-apis.mjs
 */
import { app, safeStorage } from 'electron'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

app.setName('Lovemi Auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))

const PROXY = process.env.LOVEMI_PROXY || 'http://127.0.0.1:7890'
const DRY = process.env.LOVEMI_DRY !== '0'
const API = 'https://api.lovemi.ai'

function dispatcher() {
  return new ProxyAgent(PROXY)
}

async function api(method, apiPath, token, body, extraHeaders = {}) {
  const url = `${API}${apiPath}`
  const headers = {
    Accept: 'application/json',
    'Accept-Language': 'zh-CN',
    Authorization: `Bearer ${token}`,
    Origin: 'https://app.lovemi.ai',
    Referer: 'https://app.lovemi.ai/',
    ...extraHeaders,
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await undiciFetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    dispatcher: dispatcher(),
  })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = { raw: text.slice(0, 300) }
  }
  return { status: res.status, ok: res.ok, data, headers: Object.fromEntries(res.headers) }
}

function pickIds(item) {
  const listingId = item.id || item.listing_id || item.listingId
  const assets = item.assets || item.public_assets || item.cover_assets || []
  const asset =
    (Array.isArray(assets) && assets[0]) ||
    item.primary_asset ||
    item.cover_asset ||
    item.asset ||
    null
  const assetId =
    (asset && (asset.id || asset.asset_id || asset.public_asset_id)) ||
    item.primary_asset_id ||
    item.cover_asset_id ||
    item.asset_id
  return {
    listingId,
    assetId,
    title: item.title || item.name || item.character?.display_name || item.character?.name,
    topKeys: Object.keys(item || {}).slice(0, 20),
    assetKeys: asset && typeof asset === 'object' ? Object.keys(asset).slice(0, 15) : [],
  }
}

app.whenReady().then(async () => {
  app.dock?.hide()
  try {
    const db = new DatabaseSync(path.join(app.getPath('userData'), 'accounts.sqlite'))
    const rows = db.prepare('SELECT email, payload FROM accounts').all()
    let email = ''
    let token = ''
    for (const r of rows) {
      const a = JSON.parse(safeStorage.decryptString(Buffer.from(r.payload, 'base64')))
      if (a.lovemiSessionToken) {
        email = a.email
        token = a.lovemiSessionToken
        break
      }
    }
    db.close()
    if (!token) throw new Error('no bearer')

    const list = await api(
      'GET',
      '/v1/community-listings?scope=public&listing_type=character_listing&page=1&limit=3&gender_expression=female&character_sort=popular_week',
      token,
    )
    const items = list.data?.items || []
    const samples = items.map(pickIds)

    const me = await api('GET', '/v1/me/creator-profile', token)
    const meAlt = me.ok ? null : await api('GET', '/v1/auth/me', token)

    const out = {
      dry: DRY,
      account: email,
      listingsStatus: list.status,
      sampleCount: samples.length,
      samples,
      creatorProfileGet: { status: me.status, keys: me.data && typeof me.data === 'object' ? Object.keys(me.data).slice(0, 30) : [], preview: redactProfile(me.data) },
      authMe: meAlt ? { status: meAlt.status, keys: meAlt.data && typeof meAlt.data === 'object' ? Object.keys(meAlt.data).slice(0, 20) : [] } : undefined,
    }

    if (!DRY && samples[0]?.listingId && samples[0]?.assetId) {
      const { listingId, assetId } = samples[0]
      const like = await api('PUT', `/v1/community-listings/${listingId}/assets/${assetId}/likes`, token, {})
      out.like = { status: like.status, ok: like.ok, dataKeys: like.data && typeof like.data === 'object' ? Object.keys(like.data) : [], error: like.ok ? undefined : like.data }

      const bodies = [{ body: 'Nice!' }, { text: 'Nice!' }, { content: 'Nice!' }, { comment: 'Nice!' }]
      out.commentAttempts = []
      for (const body of bodies) {
        const idem = `asset-comment:${listingId}:${assetId}:${createHash('sha256').update(randomUUID()).digest('hex').slice(0, 32)}`
        const c = await api('POST', `/v1/community-listings/${listingId}/assets/${assetId}/comments`, token, body, {
          'Idempotency-Key': idem,
        })
        out.commentAttempts.push({
          bodyKeys: Object.keys(body),
          status: c.status,
          ok: c.ok,
          error: c.ok ? undefined : c.data,
          dataKeys: c.ok && c.data && typeof c.data === 'object' ? Object.keys(c.data) : [],
        })
        if (c.ok) break
      }

      const nameBodies = [
        { display_name: 'ProbeUser' + String(Date.now()).slice(-4) },
        { username: 'probe_user_' + String(Date.now()).slice(-4) },
        { name: 'ProbeUser' + String(Date.now()).slice(-4) },
        { creator_name: 'ProbeUser' + String(Date.now()).slice(-4) },
      ]
      out.profileAttempts = []
      for (const body of nameBodies) {
        const p = await api('PATCH', '/v1/me/creator-profile', token, body)
        out.profileAttempts.push({
          bodyKeys: Object.keys(body),
          status: p.status,
          ok: p.ok,
          error: p.ok ? undefined : p.data,
          preview: p.ok ? redactProfile(p.data) : undefined,
        })
        if (p.ok) break
      }
    }

    console.log(JSON.stringify(out, null, 2))
    app.exit(0)
  } catch (e) {
    console.error(e?.cause?.message || e?.message || e)
    app.exit(1)
  }
})

function redactProfile(data) {
  if (!data || typeof data !== 'object') return data
  const copy = { ...data }
  for (const k of Object.keys(copy)) {
    if (/token|secret|email/i.test(k) && typeof copy[k] === 'string') {
      copy[k] = String(copy[k]).slice(0, 3) + '…'
    }
  }
  // keep small
  const slim = {}
  for (const k of Object.keys(copy).slice(0, 25)) slim[k] = copy[k]
  return slim
}
