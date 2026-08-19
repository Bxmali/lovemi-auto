/**
 * Probe Lovemi character publish / motion-preview video endpoints (no secrets printed).
 * LOVEMI_PROXY=http://127.0.0.1:7897 LOVEMI_CHAR_ID=chr_... env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-publish-motion.mjs
 */
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

app.setName('Lovemi Auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))

const PROXY = process.env.LOVEMI_PROXY || 'http://127.0.0.1:7897'
const API = 'https://api.lovemi.ai'
const CHAR_ID = process.env.LOVEMI_CHAR_ID || ''

function dispatcher() {
  return new ProxyAgent(PROXY)
}

function loadAdminToken() {
  const file = path.join(app.getPath('userData'), 'create-char.secrets')
  if (!fs.existsSync(file)) return ''
  const raw = fs.readFileSync(file, 'utf8').trim()
  const json = safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(Buffer.from(raw, 'base64'))
    : raw
  const parsed = JSON.parse(json)
  return parsed.adminSessionToken || ''
}

async function api(method, apiPath, token, body) {
  const url = `${API}${apiPath}`
  const headers = {
    Accept: 'application/json',
    'Accept-Language': 'zh-CN',
    Authorization: `Bearer ${token}`,
    Origin: 'https://app.lovemi.ai',
    Referer: 'https://app.lovemi.ai/',
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  try {
    const res = await undiciFetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      dispatcher: dispatcher(),
      signal: AbortSignal.timeout(45_000),
    })
    const text = await res.text()
    let data
    try {
      data = JSON.parse(text)
    } catch {
      data = { raw: text.slice(0, 400) }
    }
    const msg =
      (typeof data?.message === 'string' && data.message) ||
      (typeof data?.error === 'string' && data.error) ||
      (typeof data?.error?.message === 'string' && data.error.message) ||
      ''
    return {
      method,
      path: apiPath,
      status: res.status,
      ok: res.ok,
      msg: msg.slice(0, 160),
      keys: data && typeof data === 'object' ? Object.keys(data).slice(0, 24) : [],
      snippet: JSON.stringify(data).slice(0, 280),
    }
  } catch (e) {
    return {
      method,
      path: apiPath,
      status: 0,
      ok: false,
      msg: e instanceof Error ? e.message : String(e),
      keys: [],
      snippet: '',
    }
  }
}

function summarizeChar(data) {
  if (!data || typeof data !== 'object') return {}
  return {
    id: data.id,
    display_name: data.display_name,
    status: data.status || data.publish_status || data.visibility,
    keys: Object.keys(data).slice(0, 40),
    has_portrait: Boolean(data.latest_portrait_candidate || data.visual_profile),
    publishish: Object.keys(data).filter((k) => /publish|preview|motion|video|listing/i.test(k)),
  }
}

app.whenReady().then(async () => {
  app.dock?.hide()
  const token = loadAdminToken()
  if (!token) {
    console.log(JSON.stringify({ ok: false, error: 'no admin token in create-char.secrets' }))
    app.exit(1)
    return
  }

  const out = { ok: true, proxy: PROXY, charId: CHAR_ID || null, probes: [] }

  // list / me characters
  for (const p of [
    '/v1/characters?limit=5',
    '/v1/characters/mine?limit=5',
    '/v1/me/characters?limit=5',
    '/v1/creator/characters?limit=5',
  ]) {
    out.probes.push(await api('GET', p, token))
  }

  let charId = CHAR_ID
  if (!charId) {
    const listHit = out.probes.find((p) => p.ok)
    const items =
      listHit?.snippet &&
      (() => {
        try {
          const d = JSON.parse(listHit.snippet.includes('"items"') ? listHit.snippet : '{}')
          return d
        } catch {
          return null
        }
      })()
    // re-fetch first good list with fuller parse
    for (const p of ['/v1/characters?limit=5', '/v1/characters/mine?limit=5']) {
      const full = await api('GET', p, token)
      out.probes.push({ ...full, note: 'list-for-id' })
      if (full.ok && full.snippet.includes('chr_')) {
        const m = full.snippet.match(/chr_[A-Za-z0-9_-]+/)
        if (m) {
          charId = m[0]
          break
        }
      }
    }
  }

  if (charId) {
    out.charId = charId
    const ch = await api('GET', `/v1/characters/${encodeURIComponent(charId)}`, token)
    out.character = { status: ch.status, ok: ch.ok, msg: ch.msg, summary: null, snippet: ch.snippet }
    try {
      const data = JSON.parse(ch.snippet.includes('{') ? ch.snippet.replace(/…$/, '') : '{}')
      // snippet truncated — fetch again for keys via dedicated call below
    } catch {
      /* ignore */
    }
    // richer GET
    const rich = await (async () => {
      const url = `${API}/v1/characters/${encodeURIComponent(charId)}`
      const res = await undiciFetch(url, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          Origin: 'https://app.lovemi.ai',
          Referer: 'https://app.lovemi.ai/',
        },
        dispatcher: dispatcher(),
        signal: AbortSignal.timeout(45_000),
      })
      const data = await res.json().catch(() => ({}))
      return { status: res.status, ok: res.ok, summary: summarizeChar(data), dataKeys: Object.keys(data || {}) }
    })()
    out.characterRich = rich

    const refs = await api('GET', `/v1/characters/${encodeURIComponent(charId)}/visual-references`, token)
    out.probes.push(refs)

    // GET candidates that might document publish/motion
    const getPaths = [
      `/v1/characters/${charId}/publish`,
      `/v1/characters/${charId}/publication`,
      `/v1/characters/${charId}/preview`,
      `/v1/characters/${charId}/motion`,
      `/v1/characters/${charId}/motion-preview`,
      `/v1/characters/${charId}/preview-motion`,
      `/v1/characters/${charId}/listing`,
      `/v1/characters/${charId}/community-listing`,
    ]
    for (const p of getPaths) out.probes.push(await api('GET', p, token))

    // OPTIONS on jobs
    out.probes.push(await api('OPTIONS', '/v1/jobs', token))

    // Dry POST shapes — expect 4xx with useful validation messages
    const videoBodies = [
      {
        capability_key: 'video.generate.v1',
        job_type: 'video',
        public_model_key: 'video1',
        metadata: { character_id: charId, source: 'character_motion_preview' },
        requested_options: {
          duration_seconds: 5,
          width: 1080,
          height: 1920,
          resolution: '1080p',
          aspect_ratio: '9:16',
        },
      },
      {
        capability_key: 'video.generate.v1',
        job_type: 'video',
        public_model_key: 'video1_pro',
        character_id: charId,
        requested_options: { duration_seconds: 5, width: 1080, height: 1920 },
      },
      {
        capability_key: 'motion.preview.v1',
        job_type: 'video',
        metadata: { character_id: charId, source: 'set_preview_and_motion' },
        requested_options: { duration_seconds: 5, resolution: '1080p' },
      },
      {
        capability_key: 'image.animate.v1',
        job_type: 'video',
        metadata: { character_id: charId },
        requested_options: { duration_seconds: 5, width: 1080, height: 1920 },
      },
      {
        capability_key: 'character.motion.v1',
        job_type: 'video',
        metadata: { character_id: charId, purpose: 'preview_and_motion' },
        requested_options: { duration_seconds: 5, resolution: '1080p' },
      },
    ]

    for (const body of videoBodies) {
      out.probes.push(await api('POST', '/v1/jobs', token, body))
      out.probes.push(
        await api('POST', `/v1/characters/${encodeURIComponent(charId)}/jobs`, token, body),
      )
    }

    const publishBodies = [
      {},
      { visibility: 'public' },
      { status: 'published' },
      { action: 'publish' },
    ]
    const publishPaths = [
      `/v1/characters/${charId}/publish`,
      `/v1/characters/${charId}/publication`,
      `/v1/characters/${charId}/listings`,
      `/v1/community/listings`,
    ]
    for (const p of publishPaths) {
      for (const body of publishBodies.slice(0, 2)) {
        out.probes.push(await api('POST', p, token, body))
      }
    }

    // set preview / motion specific
    for (const p of [
      `/v1/characters/${charId}/preview-and-motion`,
      `/v1/characters/${charId}/set-preview-and-motion`,
      `/v1/characters/${charId}/preview_motion`,
      `/v1/characters/${charId}/motion-preview`,
    ]) {
      out.probes.push(
        await api('POST', p, token, {
          duration_seconds: 5,
          resolution: '1080p',
          width: 1080,
          height: 1920,
        }),
      )
    }
  }

  // interesting = not plain 404
  out.interesting = out.probes.filter(
    (p) => p.status && p.status !== 404 && !(p.status === 405 && !p.msg),
  )
  console.log(JSON.stringify(out, null, 2))
  app.exit(0)
})
