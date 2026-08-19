/**
 * Find/create companion lab_proj from character id (朵莉亚).
 * LOVEMI_PROXY=http://127.0.0.1:7897 env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-lab-from-character.mjs
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
    msg: String(data.message || data.detail || data.error || '').slice(0, 200),
    keys: Object.keys(data || {}).slice(0, 40),
    snippet: JSON.stringify(data).slice(0, 700),
    data,
  }
}

function findLabId(obj, depth = 0) {
  if (!obj || depth > 6) return null
  if (typeof obj === 'string' && obj.startsWith('lab_proj_')) return obj
  if (Array.isArray(obj)) {
    for (const x of obj) {
      const hit = findLabId(x, depth + 1)
      if (hit) return hit
    }
    return null
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if ((k === 'lab_project_id' || k === 'id' || k === 'project_id') && typeof v === 'string' && v.startsWith('lab_proj_')) {
        return v
      }
      const hit = findLabId(v, depth + 1)
      if (hit) return hit
    }
  }
  return null
}

app.whenReady().then(async () => {
  app.dock?.hide()
  const out = { char: CHAR, steps: [] }

  const getPaths = [
    `/v1/characters/${CHAR}/lab-projects`,
    `/v1/characters/${CHAR}/labs`,
    `/v1/characters/${CHAR}/companion`,
    `/v1/characters/${CHAR}/companion/project`,
    `/v1/me/lab-projects?character_id=${CHAR}`,
    `/v1/me/lab-projects?source_object_id=${CHAR}`,
    `/v1/lab-projects?character_id=${CHAR}`,
    `/v1/lab-projects?source_object_id=${CHAR}&lab_app_key=companion`,
    `/v1/lab-projects?lab_app_key=companion&limit=20`,
  ]
  for (const p of getPaths) {
    const r = await api('GET', p)
    out.steps.push({ ...r, lab: findLabId(r.data) })
  }

  // create attempts
  const createBodies = [
    { lab_app_key: 'companion', character_id: CHAR },
    { lab_app_key: 'companion', source_object_type: 'character', source_object_id: CHAR },
    { app_key: 'companion', character_id: CHAR },
    { character_ids: [CHAR], lab_app_key: 'companion' },
  ]
  for (const body of createBodies) {
    for (const p of ['/v1/lab-projects', `/v1/characters/${CHAR}/lab-projects`, `/v1/characters/${CHAR}/companion`]) {
      const r = await api('POST', p, body)
      if (r.status !== 404 && r.status !== 405) {
        out.steps.push({ step: 'create', bodyKeys: Object.keys(body), ...r, lab: findLabId(r.data) })
      }
    }
  }

  // if we already have a lab from list, stop
  let labId = out.steps.map((s) => s.lab).find(Boolean)
  out.labId = labId || null

  // also check character payload for lab refs
  const ch = await api('GET', `/v1/characters/${CHAR}`)
  out.steps.push({ step: 'character', status: ch.status, lab: findLabId(ch.data), keys: ch.keys })

  fs.writeFileSync('/tmp/probe-lab.json', JSON.stringify(out, null, 2))
  console.log(
    JSON.stringify(
      {
        labId: out.labId,
        summary: out.steps.map((s) => ({
          step: s.step,
          method: s.method,
          path: s.path,
          status: s.status,
          ok: s.ok,
          allow: s.allow,
          msg: s.msg,
          lab: s.lab || null,
          bodyKeys: s.bodyKeys,
          snippet: (s.snippet || '').slice(0, 180),
        })),
      },
      null,
      2,
    ),
  )
  app.exit(0)
})
