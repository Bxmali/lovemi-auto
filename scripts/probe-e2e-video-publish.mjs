/**
 * E2E: portrait asset → image-to-video → PUT draft → attach gallery → optional publish.
 * Default char: 朵莉亚 (unpublished). Set LOVEMI_DO_PUBLISH=1 to submit publication.
 *
 * LOVEMI_PROXY=http://127.0.0.1:7897 \
 * LOVEMI_CHAR_ID=chr_V6x4xLrXVDMprGim1fb2tw \
 * LOVEMI_SKIP_VIDEO=0 \
 * LOVEMI_DO_PUBLISH=1 \
 * env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-e2e-video-publish.mjs
 */
import { app, safeStorage } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

app.setName('Lovemi Auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))

const PROXY = process.env.LOVEMI_PROXY || 'http://127.0.0.1:7897'
const API = 'https://api.lovemi.ai'
const CHAR = process.env.LOVEMI_CHAR_ID || 'chr_V6x4xLrXVDMprGim1fb2tw'
const SKIP_VIDEO = process.env.LOVEMI_SKIP_VIDEO === '1'
const DO_PUBLISH = process.env.LOVEMI_DO_PUBLISH === '1'
const EXISTING_VIDEO = process.env.LOVEMI_VIDEO_ASSET_ID || ''
const VIDEO_WAIT_MS = Number(process.env.LOVEMI_VIDEO_WAIT_MS || 600_000)

function token() {
  const file = path.join(app.getPath('userData'), 'create-char.secrets')
  const raw = fs.readFileSync(file, 'utf8').trim()
  const json = safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(Buffer.from(raw, 'base64'))
    : raw
  return JSON.parse(json).adminSessionToken
}

function headers(t, body) {
  const h = {
    Accept: 'application/json',
    Authorization: `Bearer ${t}`,
    Origin: 'https://app.lovemi.ai',
    Referer: 'https://app.lovemi.ai/',
    'Accept-Language': 'zh-CN',
  }
  if (body) h['Content-Type'] = 'application/json'
  return h
}

async function api(method, p, t, body) {
  const res = await undiciFetch(`${API}${p}`, {
    method,
    headers: headers(t, body !== undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    dispatcher: new ProxyAgent(PROXY),
    signal: AbortSignal.timeout(90_000),
  })
  const data = await res.json().catch(() => ({}))
  const msg =
    (typeof data.message === 'string' && data.message) ||
    (typeof data.error === 'string' && data.error) ||
    (typeof data.detail === 'string' && data.detail) ||
    ''
  return { status: res.status, ok: res.ok, msg: String(msg).slice(0, 200), data, allow: res.headers.get('allow') }
}

function pickImageAsset(items) {
  const list = Array.isArray(items) ? items : []
  const scored = list
    .map((it) => {
      const id = String(it.asset_id || it.id || '')
      const kind = String(it.asset_kind || it.kind || it.content_type || '').toLowerCase()
      const role = String(it.role || it.relation_type || it.usage || '').toLowerCase()
      let score = 0
      if (kind.includes('image') || kind.includes('webp') || kind.includes('jpeg') || kind.includes('png')) score += 5
      if (role.includes('portrait') || role.includes('cover') || role.includes('visual')) score += 3
      if (id.startsWith('asset_')) score += 1
      return { id, score, kind, role }
    })
    .filter((x) => x.id.startsWith('asset_'))
    .sort((a, b) => b.score - a.score)
  return scored[0]?.id || ''
}

function pickVideoAsset(items) {
  const list = Array.isArray(items) ? items : []
  for (const it of list) {
    const id = String(it.asset_id || it.id || '')
    const kind = String(it.asset_kind || it.kind || it.content_type || '').toLowerCase()
    if (id.startsWith('asset_') && (kind.includes('video') || kind.includes('mp4'))) return id
  }
  return ''
}

function listingIdFrom(data) {
  if (!data || typeof data !== 'object') return ''
  if (typeof data.listing_id === 'string') return data.listing_id
  const listing = data.listing
  if (listing && typeof listing === 'object' && typeof listing.listing_id === 'string') return listing.listing_id
  const items = data.items
  if (Array.isArray(items) && items[0]) {
    const first = items[0]
    if (typeof first.listing_id === 'string') return first.listing_id
    if (first.listing && typeof first.listing.listing_id === 'string') return first.listing.listing_id
  }
  return ''
}

async function waitJob(t, jobId, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const r = await api('GET', `/v1/jobs/${encodeURIComponent(jobId)}`, t)
    const st = String(r.data.status || r.data.state || '').toLowerCase()
    const out = {
      status: r.status,
      ok: r.ok,
      jobStatus: st,
      keys: Object.keys(r.data || {}).slice(0, 30),
    }
    if (['succeeded', 'success', 'completed', 'done'].includes(st)) {
      const assets =
        r.data.output_asset_ids ||
        r.data.output_assets ||
        r.data.assets ||
        (r.data.result && r.data.result.output_asset_ids) ||
        []
      let videoId = ''
      if (Array.isArray(assets)) {
        for (const a of assets) {
          if (typeof a === 'string' && a.startsWith('asset_')) {
            videoId = a
            break
          }
          if (a && typeof a === 'object') {
            const id = String(a.asset_id || a.id || '')
            const kind = String(a.asset_kind || a.kind || '').toLowerCase()
            if (id.startsWith('asset_') && (!kind || kind.includes('video'))) {
              videoId = id
              break
            }
          }
        }
      }
      if (!videoId && typeof r.data.output_asset_id === 'string') videoId = r.data.output_asset_id
      return { ...out, done: true, videoId, data: r.data }
    }
    if (['failed', 'error', 'cancelled', 'canceled'].includes(st)) {
      return { ...out, done: true, failed: true, msg: r.msg, data: r.data }
    }
    await new Promise((r) => setTimeout(r, 8000))
  }
  return { done: false, timedOut: true }
}

app.whenReady().then(async () => {
  app.dock?.hide()
  const t = token()
  const out = {
    ok: false,
    char: CHAR,
    skipVideo: SKIP_VIDEO,
    doPublish: DO_PUBLISH,
    steps: [],
  }

  const charGet = await api('GET', `/v1/characters/${encodeURIComponent(CHAR)}`, t)
  out.steps.push({
    step: 'get_character',
    status: charGet.status,
    ok: charGet.ok,
    name: charGet.data.display_name,
    statusField: charGet.data.status,
  })

  const assets = await api('GET', `/v1/characters/${encodeURIComponent(CHAR)}/assets?scope=active`, t)
  const assetItems = Array.isArray(assets.data.items) ? assets.data.items : []
  let coverId = pickImageAsset(assetItems)
  let videoId = EXISTING_VIDEO || pickVideoAsset(assetItems)

  // /assets 可能为空：从 portrait candidate / visual-references 取
  if (!coverId) {
    const cand = charGet.data.latest_portrait_candidate
    const fromCand =
      cand && typeof cand === 'object'
        ? String(
            /** @type {any} */ (cand).asset_id ||
              /** @type {any} */ (cand).id ||
              '',
          )
        : ''
    if (fromCand.startsWith('asset_')) coverId = fromCand
  }
  if (!coverId) {
    const refs = await api('GET', `/v1/characters/${encodeURIComponent(CHAR)}/visual-references`, t)
    const items = Array.isArray(refs.data.items) ? refs.data.items : []
    const first = items.find((x) => typeof x.asset_id === 'string' && String(x.asset_id).startsWith('asset_'))
    if (first?.asset_id) coverId = String(first.asset_id)
    out.steps.push({
      step: 'visual_references',
      status: refs.status,
      ok: refs.ok,
      count: items.length,
      coverId: coverId || null,
      snippet: JSON.stringify(refs.data).slice(0, 400),
    })
  }

  out.steps.push({
    step: 'list_assets',
    status: assets.status,
    ok: assets.ok,
    count: assetItems.length,
    coverId: coverId || null,
    existingVideoId: videoId || null,
    kinds: assetItems.slice(0, 8).map((it) => ({
      id: it.asset_id || it.id,
      kind: it.asset_kind || it.kind,
    })),
  })

  if (!coverId) {
    out.error = 'no portrait/cover image asset on character (assets + visual-references empty)'
    console.log(JSON.stringify(out, null, 2))
    app.exit(1)
    return
  }

  if (!videoId && !SKIP_VIDEO) {
    const threadId = `gen_${createHash('sha256').update(`${coverId}|${Date.now()}|${randomUUID()}`).digest('hex').slice(0, 32)}`
    const body = {
      public_model_key: 'video1_pro',
      capability_key: 'video.image_to_video.v1',
      prompt:
        'Subtle natural motion, soft breathing, gentle hair sway, cinematic portrait, keep face identity locked, no morphing.',
      aspect_ratio: 'portrait',
      duration_seconds: 5,
      width: 1088,
      height: 1920,
      input_asset_ids: [coverId],
      prompt_enhancement: true,
      metadata: {
        generation_mode: 'image_to_video',
        generation_thread_id: threadId,
        product_model: 'Video1-pro',
      },
      requested_options: {
        aspect: 'portrait',
        aspect_ratio: '9:16',
        reference_asset_count: 1,
      },
    }
    const started = await api('POST', '/v1/jobs', t, body)
    const jobId =
      (typeof started.data.id === 'string' && started.data.id) ||
      (typeof started.data.job_id === 'string' && started.data.job_id) ||
      ''
    out.steps.push({
      step: 'start_video',
      status: started.status,
      ok: started.ok,
      msg: started.msg,
      jobId: jobId || null,
      keys: Object.keys(started.data || {}).slice(0, 20),
    })
    if (!started.ok || !jobId) {
      out.error = started.msg || 'failed to start video job'
      console.log(JSON.stringify(out, null, 2))
      app.exit(1)
      return
    }
    const waited = await waitJob(t, jobId, VIDEO_WAIT_MS)
    out.steps.push({
      step: 'wait_video',
      ...waited,
      dataKeys: waited.data ? Object.keys(waited.data).slice(0, 40) : [],
      snippet: waited.data ? JSON.stringify(waited.data).slice(0, 500) : '',
    })
    if (!waited.done || waited.failed || !waited.videoId) {
      out.error = waited.failed ? 'video job failed' : 'video job timed out or no output asset'
      console.log(JSON.stringify(out, null, 2))
      app.exit(1)
      return
    }
    videoId = waited.videoId
  }

  if (!videoId) {
    out.steps.push({ step: 'video', skipped: true, reason: SKIP_VIDEO ? 'LOVEMI_SKIP_VIDEO=1' : 'no video' })
  }

  const draftBody = {
    listing_type: 'character_listing',
    title: String(charGet.data.display_name || '测试角色') + ' · e2e',
    description: 'LovemiAuto e2e probe — draft preview with cover + gallery video',
    adult_content: true,
    clear_cover_asset: false,
    clear_description: false,
    content_rating: 'adult',
    cover_asset_id: coverId,
    preview_mode: 'full',
    price_coins: 0,
    pricing_mode: 'free',
    supported_lab_apps: ['companion', 'intimacy_lab', 'galgame', 'adult_film_director'],
    tags: ['e2e-probe'],
  }
  const draft = await api(
    'PUT',
    `/v1/me/publications/by-source/character/${encodeURIComponent(CHAR)}/draft`,
    t,
    draftBody,
  )
  let listingId = listingIdFrom(draft.data)
  out.steps.push({
    step: 'put_draft',
    status: draft.status,
    ok: draft.ok,
    msg: draft.msg,
    listingId: listingId || null,
    keys: Object.keys(draft.data || {}).slice(0, 30),
    snippet: JSON.stringify(draft.data).slice(0, 400),
  })
  if (!draft.ok) {
    out.error = draft.msg || 'put draft failed'
    console.log(JSON.stringify(out, null, 2))
    app.exit(1)
    return
  }

  if (!listingId) {
    const pubs = await api(
      'GET',
      `/v1/me/publications?listing_type=character_listing&source_object_type=character&source_object_ids=${encodeURIComponent(CHAR)}&limit=5`,
      t,
    )
    listingId = listingIdFrom(pubs.data)
    out.steps.push({
      step: 'resolve_listing',
      status: pubs.status,
      ok: pubs.ok,
      listingId: listingId || null,
      snippet: JSON.stringify(pubs.data).slice(0, 500),
    })
  }

  let videoAttachOk = null
  if (videoId && listingId) {
    const attachPath = `/v1/community-listings/${encodeURIComponent(listingId)}/draft-assets`
    const bodies = [
      { asset_id: videoId, relation_type: 'gallery' },
      { source_asset_id: videoId, relation_type: 'gallery' },
      { items: [{ asset_id: videoId, relation_type: 'gallery' }] },
      { asset_id: videoId, relation_type: 'gallery', sort_order: 1 },
    ]
    let attached = null
    for (const body of bodies) {
      for (const method of ['POST', 'PUT', 'PATCH']) {
        const r = await api(method, attachPath, t, body)
        out.steps.push({
          step: 'attach_try',
          method,
          status: r.status,
          ok: r.ok,
          msg: r.msg,
          allow: r.allow,
          bodyKeys: Object.keys(body),
          snippet: JSON.stringify(r.data).slice(0, 240),
        })
        if (r.ok) {
          attached = r
          break
        }
      }
      if (attached) break
    }
    videoAttachOk = Boolean(attached?.ok)
    if (attached?.ok) {
      const check = await api('GET', attachPath, t)
      out.steps.push({
        step: 'draft_assets_after',
        status: check.status,
        ok: check.ok,
        count: Array.isArray(check.data.items) ? check.data.items.length : 0,
        items: (Array.isArray(check.data.items) ? check.data.items : []).map((it) => ({
          asset_id: it.asset_id,
          kind: it.asset_kind,
          relation: it.relation_type,
        })),
      })
    }
  } else if (videoId && !listingId) {
    out.steps.push({ step: 'attach_skip', reason: 'no listingId after draft' })
  }

  let publishOk = null
  if (DO_PUBLISH) {
    if (!listingId) {
      out.error = 'draft ok but no listingId; cannot publish'
      console.log(JSON.stringify(out, null, 2))
      app.exit(1)
      return
    }
    const sub = await api(
      'POST',
      `/v1/community-listings/${encodeURIComponent(listingId)}/publication-submissions`,
      t,
      { publication_scope: 'character', source_locale: 'zh-CN' },
    )
    publishOk = sub.ok
    out.steps.push({
      step: 'publish_submit',
      status: sub.status,
      ok: sub.ok,
      msg: sub.msg,
      keys: Object.keys(sub.data || {}).slice(0, 24),
      snippet: JSON.stringify(sub.data).slice(0, 400),
    })
  }

  out.ok = draft.ok && (videoId ? videoAttachOk !== false : true) && (DO_PUBLISH ? publishOk : true)
  out.coverId = coverId
  out.videoId = videoId || null
  out.listingId = listingId || null
  out.videoAttachOk = videoAttachOk
  out.publishOk = publishOk
  console.log(JSON.stringify(out, null, 2))
  app.exit(out.ok ? 0 : 1)
})
