import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fetch as undiciFetch, ProxyAgent } from 'undici'
app.setName('Lovemi Auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))
const PROXY = 'http://127.0.0.1:7897'
const API = 'https://api.lovemi.ai'
const CHAR = 'chr_V6x4xLrXVDMprGim1fb2tw'
const LAB = 'lab_proj_CccKY_x2_xoDRIs4q-Vdpg'
const PROMPT = process.env.LOVEMI_MSG || '想看你自慰视频'
function token() {
  const file = path.join(app.getPath('userData'), 'create-char.secrets')
  const raw = fs.readFileSync(file, 'utf8').trim()
  const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(raw, 'base64')) : raw
  return JSON.parse(json).adminSessionToken
}
async function api(method, p, body, extraHeaders = {}) {
  const res = await undiciFetch(API + p, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: 'Bearer ' + token(),
      Origin: 'https://app.lovemi.ai',
      Referer: 'https://app.lovemi.ai/',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    dispatcher: new ProxyAgent(PROXY),
    signal: AbortSignal.timeout(90000),
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, ok: res.ok, msg: String(data.message||'').slice(0,200), keys: Object.keys(data||{}), snippet: JSON.stringify(data).slice(0,1200), data }
}
app.whenReady().then(async () => {
  app.dock?.hide()
  const out = { steps: [] }
  const idem = `companion-msg:${randomUUID()}`
  const msg = await api('POST', `/v1/lab-projects/${LAB}/companion/messages`, {
    content: PROMPT,
    asset_ids: [],
    interaction: { kind: 'message', audience: 'group', target_character_ids: [] },
  }, { 'Idempotency-Key': idem })
  out.message = { status: msg.status, ok: msg.ok, msg: msg.msg, keys: msg.keys, snippet: msg.snippet }
  const jobIds = [...new Set([...(JSON.stringify(msg.data).matchAll(/job_[a-f0-9]+/g) || [])].map(m => m[0]))]
  out.jobIdsFromMsg = jobIds

  // poll thread + jobs for up to 4 min looking for video capability or character video asset
  const start = Date.now()
  while (Date.now() - start < 240000) {
    const thread = await api('GET', `/v1/lab-projects/${LAB}/companion/messages?limit=10`)
    const moreJobs = [...new Set([...(JSON.stringify(thread.data).matchAll(/job_[a-f0-9]+/g) || [])].map(m => m[0]))]
    out.latestThreadSnippet = thread.snippet.slice(0, 500)
    out.allJobIds = [...new Set([...jobIds, ...moreJobs])]

    for (const jid of out.allJobIds.slice(-5)) {
      const j = await api('GET', `/v1/jobs/${jid}`)
      out.steps.push({
        job: jid,
        status: j.data.status,
        type: j.data.job_type,
        cap: j.data.capability_key,
        created: j.data.requested_at,
      })
    }

    const assets = await api('GET', `/v1/characters/${CHAR}/assets?scope=active`)
    const items = Array.isArray(assets.data.items) ? assets.data.items : []
    out.assets = items.map(it => ({ id: it.asset_id, kind: it.asset_kind, relation: it.relation_type }))
    if (items.some(it => String(it.asset_kind).includes('video'))) break

    // also check if any job is video
    const last = out.steps.slice(-5)
    if (last.some(x => x.type === 'video' && /complete|succeed/i.test(String(x.status)))) break

    await new Promise(r => setTimeout(r, 10000))
  }

  fs.writeFileSync('/tmp/companion-msg-once.json', JSON.stringify(out, null, 2))
  console.log(JSON.stringify({
    messageOk: out.message?.ok,
    messageStatus: out.message?.status,
    messageMsg: out.message?.msg,
    messageSnippet: out.message?.snippet?.slice(0, 400),
    jobIds: out.allJobIds,
    assets: out.assets,
    recentJobs: out.steps.slice(-8),
  }, null, 2))
  app.exit(0)
})
