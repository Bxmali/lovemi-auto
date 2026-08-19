/**
 * Attach video gallery + submit publish for 朵莉亚 listing.
 */
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

app.setName('Lovemi Auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))
const PROXY = 'http://127.0.0.1:7897'
const API = 'https://api.lovemi.ai'
const CHAR = 'chr_V6x4xLrXVDMprGim1fb2tw'
const LISTING = process.env.LOVEMI_LISTING_ID || 'listing_AAS0E63adiNWjlKtDBwuOQ'
const JOB = 'job_e42d8d9531da941e9a49eefdbac6b967'
const DO_PUBLISH = process.env.LOVEMI_DO_PUBLISH !== '0'

function token() {
  const file = path.join(app.getPath('userData'), 'create-char.secrets')
  const raw = fs.readFileSync(file, 'utf8').trim()
  const json = safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(Buffer.from(raw, 'base64'))
    : raw
  return JSON.parse(json).adminSessionToken
}

async function api(method, p, body) {
  const res = await undiciFetch(API + p, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: 'Bearer ' + token(),
      Origin: 'https://app.lovemi.ai',
      Referer: 'https://app.lovemi.ai/',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    dispatcher: new ProxyAgent(PROXY),
    signal: AbortSignal.timeout(45000),
  })
  const data = await res.json().catch(() => ({}))
  return {
    method,
    path: p,
    status: res.status,
    ok: res.ok,
    allow: res.headers.get('allow'),
    msg: String(data.message || data.error || data.detail || '').slice(0, 200),
    keys: Object.keys(data || {}).slice(0, 30),
    data,
    snippet: JSON.stringify(data).slice(0, 600),
  }
}

app.whenReady().then(async () => {
  app.dock?.hide()
  const out = { listing: LISTING, steps: [] }

  // find video asset from our job
  const assets = await api('GET', '/v1/assets?limit=50')
  const items = Array.isArray(assets.data.items) ? assets.data.items : []
  const videos = items.filter((it) => String(it.asset_kind || '').includes('video'))
  out.steps.push({
    step: 'list_assets',
    status: assets.status,
    videoCount: videos.length,
    videos: videos.slice(0, 8).map((it) => ({
      id: it.asset_id,
      kind: it.asset_kind,
      origin: it.asset_origin,
      created: it.created_at,
      job: it.source_generation_job_id || it.generation_job_id || it.job_id,
      meta: it.metadata ? Object.keys(it.metadata).slice(0, 10) : [],
      snip: JSON.stringify(it).slice(0, 220),
    })),
  })

  let videoId = process.env.LOVEMI_VIDEO_ASSET_ID || ''
  if (!videoId) {
    const byJob = videos.find((it) => {
      const s = JSON.stringify(it)
      return s.includes(JOB)
    })
    videoId = byJob?.asset_id || videos[0]?.asset_id || ''
  }
  out.videoId = videoId

  const draftAssetsPath = `/v1/community-listings/${LISTING}/draft-assets`
  out.steps.push({ step: 'options', ...(await api('OPTIONS', draftAssetsPath)) })
  out.steps.push({ step: 'get_before', ...(await api('GET', draftAssetsPath)) })

  if (!videoId) {
    out.error = 'no video asset found'
    console.log(JSON.stringify(out, null, 2))
    app.exit(1)
    return
  }

  const bodies = [
    { asset_id: videoId, relation_type: 'gallery' },
    { source_asset_id: videoId, relation_type: 'gallery' },
    { asset_id: videoId, relation_type: 'gallery', sort_order: 1 },
    { items: [{ asset_id: videoId, relation_type: 'gallery' }] },
    { asset_ids: [videoId], relation_type: 'gallery' },
  ]
  let attached = null
  for (const body of bodies) {
    for (const method of ['POST', 'PUT', 'PATCH']) {
      const r = await api(method, draftAssetsPath, body)
      out.steps.push({
        step: 'attach_try',
        method,
        bodyKeys: Object.keys(body),
        status: r.status,
        ok: r.ok,
        msg: r.msg,
        allow: r.allow,
        snippet: r.snippet,
      })
      if (r.ok) {
        attached = r
        break
      }
    }
    if (attached) break
  }

  out.attachOk = Boolean(attached?.ok)
  out.steps.push({ step: 'get_after', ...(await api('GET', draftAssetsPath)) })

  if (DO_PUBLISH) {
    const sub = await api('POST', `/v1/community-listings/${LISTING}/publication-submissions`, {
      publication_scope: 'character',
      source_locale: 'zh-CN',
    })
    out.steps.push({ step: 'publish', status: sub.status, ok: sub.ok, msg: sub.msg, snippet: sub.snippet })
    out.publishOk = sub.ok
  }

  out.ok = out.attachOk && (!DO_PUBLISH || out.publishOk)
  fs.writeFileSync('/tmp/attach-publish.json', JSON.stringify(out, null, 2))
  console.log(JSON.stringify(out, null, 2))
  app.exit(out.ok ? 0 : 1)
})
