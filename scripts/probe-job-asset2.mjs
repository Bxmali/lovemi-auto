import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fetch as undiciFetch, ProxyAgent } from 'undici'
app.setName('Lovemi Auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))
const PROXY = 'http://127.0.0.1:7897'
const API = 'https://api.lovemi.ai'
const JOB = 'job_e42d8d9531da941e9a49eefdbac6b967'
const CHAR = 'chr_V6x4xLrXVDMprGim1fb2tw'
function token() {
  const file = path.join(app.getPath('userData'), 'create-char.secrets')
  const raw = fs.readFileSync(file, 'utf8').trim()
  const json = safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(Buffer.from(raw, 'base64'))
    : raw
  return JSON.parse(json).adminSessionToken
}
async function api(method, p, body) {
  try {
    const res = await undiciFetch(API + p, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer ' + token(),
        Origin: 'https://app.lovemi.ai',
        Referer: 'https://app.lovemi.ai/',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      dispatcher: new ProxyAgent(PROXY),
      signal: AbortSignal.timeout(20000),
    })
    const data = await res.json().catch(() => ({}))
    return { status: res.status, ok: res.ok, allow: res.headers.get('allow'), keys: Object.keys(data||{}), snippet: JSON.stringify(data).slice(0, 800), assets: [...JSON.stringify(data).matchAll(/asset_[A-Za-z0-9_-]+/g)].map(m=>m[0]) }
  } catch (e) {
    return { status: 0, ok: false, error: String(e) }
  }
}
app.whenReady().then(async () => {
  app.dock?.hide()
  const out = { jobAssets: null, probes: [] }
  const job = await api('GET', `/v1/jobs/${JOB}`)
  out.job = { status: job.status, assets: job.assets, snippet: job.snippet }
  for (const p of [
    `/v1/jobs/${JOB}/outputs`,
    `/v1/jobs/${JOB}/assets`,
    `/v1/me/assets?limit=10`,
    `/v1/assets?limit=10`,
    `/v1/characters/${CHAR}/assets?scope=all`,
    `/v1/characters/${CHAR}/visual-references`,
  ]) {
    out.probes.push({ path: p, ...(await api('GET', p)) })
  }
  // try create asset from job
  for (const body of [
    { job_id: JOB, kind: 'video' },
    { source_job_id: JOB },
    { generation_job_id: JOB },
  ]) {
    out.probes.push({ path: 'POST /v1/assets', body, ...(await api('POST', '/v1/assets', body)) })
    out.probes.push({ path: 'POST /v1/me/assets', body, ...(await api('POST', '/v1/me/assets', body)) })
  }
  // draft with cover only for 朵莉亚 — get listing then try attach by cdn? 
  const draft = await api('PUT', `/v1/me/publications/by-source/character/${CHAR}/draft`, {
    listing_type: 'character_listing',
    title: '朵莉亚 · e2e',
    description: 'probe',
    adult_content: true,
    clear_cover_asset: false,
    clear_description: false,
    content_rating: 'adult',
    cover_asset_id: 'asset_8918',
    preview_mode: 'full',
    price_coins: 0,
    pricing_mode: 'free',
    supported_lab_apps: ['companion', 'intimacy_lab', 'galgame', 'adult_film_director'],
    tags: [],
  })
  out.draft = draft
  fs.writeFileSync('/tmp/job-asset2.json', JSON.stringify(out, null, 2))
  console.log('WROTE /tmp/job-asset2.json')
  console.log(JSON.stringify({ jobStatus: job.status, jobAssets: job.assets, draftOk: draft.ok, draftStatus: draft.status, draftSnippet: draft.snippet?.slice(0,300), probeSummary: out.probes.map(p => ({ path: p.path, status: p.status, assets: p.assets, allow: p.allow, msg: (p.snippet||'').slice(0,120) })) }, null, 2))
  app.exit(0)
})
