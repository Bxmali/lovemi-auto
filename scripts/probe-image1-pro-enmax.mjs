/**
 * Binary-ish probe for English Image1-pro prompt max chars.
 * env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-image1-pro-enmax.mjs
 */
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

app.setName('Lovemi Auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))

const PROXY = process.env.LOVEMI_PROXY || 'http://127.0.0.1:7897'
const API = 'https://api.lovemi.ai'

function token() {
  const file = path.join(app.getPath('userData'), 'create-char.secrets')
  const raw = fs.readFileSync(file, 'utf8').trim()
  const json = safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(Buffer.from(raw, 'base64'))
    : raw
  return JSON.parse(json).adminSessionToken
}

function padEn(n) {
  const base =
    'A photorealistic 21+ adult Japanese woman alone in a luxury hotel room masturbating, cute East Asian face, silk slip dress, neatly trimmed pubic hair, warm gold light, cinematic 16:9, single coherent scene. '
  let s = base
  while (s.length < n) s += 'More details about pose lighting fabric skin texture camera angle. '
  return s.slice(0, n)
}

function bodyFor(prompt) {
  const threadId = `gen_${createHash('sha256').update(`${prompt}|${Date.now()}|${randomUUID()}`).digest('hex').slice(0, 32)}`
  return {
    public_model_key: 'image1_pro',
    capability_key: 'image.generate.v1',
    prompt,
    aspect_ratio: 'landscape',
    width: 2304,
    height: 1280,
    prompt_enhancement: true,
    metadata: {
      public_model_key: 'image1_pro',
      product_model: 'Image1-pro',
      aspect_ratio: '16:9',
      generation_mode: 'text_to_image',
      generation_thread_id: threadId,
      prompt,
      prompt_enhancement: 'true',
    },
    requested_options: {
      public_model_key: 'image1_pro',
      model_label: 'Image1-pro',
      aspect_ratio: '16:9',
      aspect: 'landscape',
      width: 2304,
      height: 1280,
      prompt,
      prompt_enhancement: true,
    },
  }
}

async function post(token, prompt) {
  const res = await undiciFetch(`${API}/v1/jobs`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      Origin: 'https://app.lovemi.ai',
      Referer: 'https://app.lovemi.ai/',
    },
    body: JSON.stringify(bodyFor(prompt)),
    dispatcher: new ProxyAgent(PROXY),
    signal: AbortSignal.timeout(45_000),
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, ok: res.ok, error: data.message || data.detail }
}

app.whenReady().then(async () => {
  app.dock?.hide()
  const t = token()
  const results = []
  for (const n of [220, 250, 280, 300, 320, 350]) {
    const prompt = padEn(n)
    const r = await post(t, prompt)
    results.push({ chars: n, ...r })
    await new Promise((x) => setTimeout(x, 650))
  }
  console.log(JSON.stringify({ results }, null, 2))
  app.exit(0)
})
