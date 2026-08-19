/**
 * Create companion lab for 朵莉亚 → set media prefs → POST message → watch jobs/assets.
 */
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

app.setName('Lovemi Auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))
const PROXY = process.env.LOVEMI_PROXY || 'http://127.0.0.1:7897'
const API = 'https://api.lovemi.ai'
const CHAR = process.env.LOVEMI_CHAR_ID || 'chr_V6x4xLrXVDMprGim1fb2tw'
const PROMPT = process.env.LOVEMI_MSG || '想看你的动态视频预览'
const DO_MSG = process.env.LOVEMI_DO_MSG !== '0'

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
    signal: AbortSignal.timeout(60000),
  })
  const data = await res.json().catch(() => ({}))
  return {
    method,
    path: p,
    status: res.status,
    ok: res.ok,
    msg: String(data.message || data.detail || '').slice(0, 220),
    issues: data.issues,
    keys: Object.keys(data || {}).slice(0, 40),
    snippet: JSON.stringify(data).slice(0, 900),
    data,
  }
}

app.whenReady().then(async () => {
  app.dock?.hide()
  const out = { char: CHAR, steps: [] }

  // list existing
  let list = await api('GET', `/v1/lab-projects?character_id=${encodeURIComponent(CHAR)}&lab_app_key=companion`)
  out.steps.push({ step: 'list', status: list.status, snippet: list.snippet.slice(0, 300) })
  let labId =
    (Array.isArray(list.data.items) && list.data.items[0]?.lab_project_id) ||
    (Array.isArray(list.data.items) && list.data.items[0]?.id) ||
    null
  if (!labId && Array.isArray(list.data.items) && list.data.items[0]) {
    const s = JSON.stringify(list.data.items[0])
    const m = s.match(/lab_proj_[A-Za-z0-9_-]+/)
    labId = m?.[0] || null
  }

  if (!labId) {
    // try create variants with title
    const creates = [
      { title: '朵莉亚 companion', lab_app_key: 'companion', character_ids: [CHAR] },
      { title: '朵莉亚 companion', lab_app_key: 'companion', characters: [{ character_id: CHAR, character_role: 'primary' }] },
      { title: '朵莉亚 companion', lab_app_key: 'companion', primary_character_id: CHAR },
    ]
    for (const body of creates) {
      const r = await api('POST', '/v1/lab-projects', body)
      out.steps.push({ step: 'create', bodyKeys: Object.keys(body), status: r.status, ok: r.ok, msg: r.msg, issues: r.issues, snippet: r.snippet.slice(0, 400) })
      if (r.ok) {
        const s = JSON.stringify(r.data)
        const m = s.match(/lab_proj_[A-Za-z0-9_-]+/)
        labId = m?.[0] || r.data.lab_project_id || r.data.id || null
        if (labId) break
      }
    }
  }

  out.labId = labId
  if (!labId) {
    out.error = 'no lab_proj'
    console.log(JSON.stringify(out, null, 2))
    app.exit(1)
    return
  }

  // media preferences
  const prefs = await api('PATCH', `/v1/lab-projects/${labId}/companion/contact`, {
    media_preferences: {
      image_aspect_ratio: '3:4',
      image_resolution: '3mp',
      mode: 'auto',
      video_aspect_ratio: '9:16',
      video_duration_seconds: 5,
      video_resolution: '1080p',
    },
    proactive_mode: 'off',
    relationship_enabled: false,
  })
  out.steps.push({ step: 'prefs', status: prefs.status, ok: prefs.ok, msg: prefs.msg, snippet: prefs.snippet.slice(0, 300) })

  if (!DO_MSG) {
    console.log(JSON.stringify(out, null, 2))
    app.exit(0)
    return
  }

  const msg = await api('POST', `/v1/lab-projects/${labId}/companion/messages`, {
    content: PROMPT,
    asset_ids: [],
    interaction: { kind: 'message', audience: 'group', target_character_ids: [] },
  })
  out.steps.push({
    step: 'message',
    status: msg.status,
    ok: msg.ok,
    msg: msg.msg,
    keys: msg.keys,
    snippet: msg.snippet,
  })

  // extract job ids from message response
  const jobIds = [...JSON.stringify(msg.data).matchAll(/job_[a-f0-9]+/g)].map((m) => m[0])
  out.jobIds = [...new Set(jobIds)]

  // poll jobs up to ~3 min
  const started = Date.now()
  const jobResults = []
  while (Date.now() - started < 180_000) {
    // refresh character assets
    const assets = await api('GET', `/v1/characters/${CHAR}/assets?scope=active`)
    const items = Array.isArray(assets.data.items) ? assets.data.items : []
    const videos = items.filter((it) => String(it.asset_kind || '').includes('video'))
    if (videos.length) {
      out.characterVideos = videos.map((v) => ({ id: v.asset_id, kind: v.asset_kind, relation: v.relation_type }))
      break
    }
    for (const jid of out.jobIds) {
      const j = await api('GET', `/v1/jobs/${jid}`)
      jobResults.push({
        id: jid,
        status: j.data.status,
        type: j.data.job_type,
        cap: j.data.capability_key,
        outputs: j.data.outputs,
      })
    }
    // also try list recent jobs if message didn't embed id
    if (!out.jobIds.length) {
      // peek message thread?
      const thread = await api('GET', `/v1/lab-projects/${labId}/companion/messages?limit=5`)
      out.steps.push({ step: 'thread', status: thread.status, snippet: thread.snippet.slice(0, 500) })
      const more = [...JSON.stringify(thread.data).matchAll(/job_[a-f0-9]+/g)].map((m) => m[0])
      out.jobIds = [...new Set([...(out.jobIds || []), ...more])]
    }
    await new Promise((r) => setTimeout(r, 8000))
  }
  out.jobResults = jobResults.slice(-6)
  out.steps.push({ step: 'assets_final', ...(await api('GET', `/v1/characters/${CHAR}/assets?scope=active`)) })

  fs.writeFileSync('/tmp/probe-companion-video.json', JSON.stringify(out, null, 2))
  console.log(JSON.stringify({
    labId: out.labId,
    jobIds: out.jobIds,
    characterVideos: out.characterVideos || null,
    jobResults: out.jobResults,
    summary: out.steps.map(s => ({ step: s.step, status: s.status, ok: s.ok, msg: s.msg, issues: s.issues, snippet: (s.snippet||'').slice(0,250) })),
  }, null, 2))
  app.exit(0)
})
