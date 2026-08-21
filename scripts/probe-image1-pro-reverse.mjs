/**
 * Reverse-engineer Image1-pro job body from recent jobs + body variants.
 * env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-image1-pro-reverse.mjs
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
const PROMPT = '一个日本美女自慰'

function token() {
  const file = path.join(app.getPath('userData'), 'create-char.secrets')
  const raw = fs.readFileSync(file, 'utf8').trim()
  const json = safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(Buffer.from(raw, 'base64'))
    : raw
  return JSON.parse(json).adminSessionToken
}

async function api(token, method, pathName, body) {
  const res = await undiciFetch(`${API}${pathName}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${token}`,
      Origin: 'https://app.lovemi.ai',
      Referer: 'https://app.lovemi.ai/',
      'Accept-Language': 'zh-CN',
    },
    body: body ? JSON.stringify(body) : undefined,
    dispatcher: new ProxyAgent(PROXY),
    signal: AbortSignal.timeout(45_000),
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, ok: res.ok, data }
}

function summarizeJob(job) {
  const meta = (job.metadata || {}) 
  const req = (job.requested_options || {})
  return {
    id: job.id || job.job_id,
    status: job.status,
    capability_key: job.capability_key,
    public_model_key: job.public_model_key || meta.public_model_key,
    job_type: job.job_type,
    aspect_ratio: job.aspect_ratio || meta.aspect_ratio || req.aspect_ratio,
    width: job.width || req.width,
    height: job.height || req.height,
    generation_mode: meta.generation_mode,
    topKeys: Object.keys(job).slice(0, 30),
    metadataKeys: Object.keys(meta).slice(0, 30),
    requestedKeys: Object.keys(req).slice(0, 30),
    hasPromptTop: typeof job.prompt === 'string',
    promptTopLen: typeof job.prompt === 'string' ? [...job.prompt].length : 0,
    promptMetaLen: typeof meta.prompt === 'string' ? [...meta.prompt].length : 0,
    promptReqLen: typeof req.prompt === 'string' ? [...req.prompt].length : 0,
    rawSnippet: JSON.stringify(job).slice(0, 1200),
  }
}

app.whenReady().then(async () => {
  app.dock?.hide()
  const t = token()
  if (!t) {
    console.log(JSON.stringify({ ok: false, error: 'no admin token' }))
    app.exit(1)
    return
  }

  const me = await api(t, 'GET', '/v1/me')
  const jobs = await api(t, 'GET', '/v1/jobs?limit=20')
  const items = Array.isArray(jobs.data?.items)
    ? jobs.data.items
    : Array.isArray(jobs.data)
      ? jobs.data
      : []

  const imageJobs = items
    .filter((j) => {
      const s = JSON.stringify(j)
      return /image1_pro|image\.generate|image\.edit|text_to_image/i.test(s)
    })
    .slice(0, 5)
    .map(summarizeJob)

  const threadId = `gen_${createHash('sha256').update(`${PROMPT}|${Date.now()}|${randomUUID()}`).digest('hex').slice(0, 32)}`

  const variants = [
    {
      name: 'exact_numbers',
      body: {
        public_model_key: 'image1_pro',
        capability_key: 'image.generate.v1',
        prompt: PROMPT,
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
          prompt: PROMPT,
          prompt_enhancement: true,
        },
        requested_options: {
          public_model_key: 'image1_pro',
          model_label: 'Image1-pro',
          aspect_ratio: '16:9',
          aspect: 'landscape',
          width: 2304,
          height: 1280,
          prompt: PROMPT,
          prompt_enhancement: true,
        },
      },
    },
    {
      name: 'string_wh',
      body: {
        public_model_key: 'image1_pro',
        capability_key: 'image.generate.v1',
        prompt: PROMPT,
        aspect_ratio: '16:9',
        width: '2304',
        height: '1280',
        prompt_enhancement: true,
        metadata: {
          public_model_key: 'image1_pro',
          product_model: 'Image1-pro',
          aspect_ratio: '16:9',
          generation_mode: 'text_to_image',
          generation_thread_id: threadId + 'a',
          prompt: PROMPT,
          prompt_enhancement: true,
        },
        requested_options: {
          public_model_key: 'image1_pro',
          model_label: 'Image1-pro',
          aspect_ratio: '16:9',
          aspect: 'landscape',
          width: 2304,
          height: 1280,
          prompt: PROMPT,
          prompt_enhancement: true,
        },
      },
    },
    {
      name: 'aspect_16_9_top',
      body: {
        public_model_key: 'image1_pro',
        capability_key: 'image.generate.v1',
        prompt: PROMPT,
        aspect_ratio: '16:9',
        width: 2304,
        height: 1280,
        prompt_enhancement: true,
        metadata: {
          public_model_key: 'image1_pro',
          product_model: 'Image1-pro',
          aspect_ratio: '16:9',
          generation_mode: 'text_to_image',
          generation_thread_id: threadId + 'b',
          prompt: PROMPT,
          prompt_enhancement: true,
        },
        requested_options: {
          public_model_key: 'image1_pro',
          model_label: 'Image1-pro',
          aspect_ratio: '16:9',
          aspect: 'landscape',
          width: 2304,
          height: 1280,
          prompt: PROMPT,
          prompt_enhancement: true,
        },
      },
    },
    {
      name: 'minimal_core',
      body: {
        public_model_key: 'image1_pro',
        capability_key: 'image.generate.v1',
        prompt: PROMPT,
        aspect_ratio: 'landscape',
        width: 2304,
        height: 1280,
      },
    },
    {
      name: 'with_empty_assets',
      body: {
        public_model_key: 'image1_pro',
        capability_key: 'image.generate.v1',
        prompt: PROMPT,
        aspect_ratio: 'landscape',
        width: 2304,
        height: 1280,
        prompt_enhancement: true,
        input_asset_ids: [],
        metadata: {
          public_model_key: 'image1_pro',
          product_model: 'Image1-pro',
          aspect_ratio: '16:9',
          generation_mode: 'text_to_image',
          generation_thread_id: threadId + 'c',
          prompt: PROMPT,
          prompt_enhancement: true,
        },
        requested_options: {
          public_model_key: 'image1_pro',
          model_label: 'Image1-pro',
          aspect_ratio: '16:9',
          aspect: 'landscape',
          width: 2304,
          height: 1280,
          prompt: PROMPT,
          prompt_enhancement: true,
          input_asset_ids: [],
          reference_asset_count: 0,
        },
      },
    },
    {
      name: 'portrait_1088_like_char',
      body: {
        public_model_key: 'image1_pro',
        capability_key: 'image.generate.v1',
        prompt: PROMPT,
        metadata: {
          public_model_key: 'image1_pro',
          product_model: 'Image1-pro',
          aspect_ratio: '9:16',
          generation_thread_id: threadId + 'd',
          prompt_enhancement: true,
          prompt: PROMPT,
        },
        requested_options: {
          public_model_key: 'image1_pro',
          model_label: 'Image1-pro',
          aspect_ratio: '9:16',
          aspect: 'portrait',
          width: 1088,
          height: 1920,
          prompt_enhancement: true,
          prompt: PROMPT,
        },
      },
    },
  ]

  // If we found a recent image job with requested_options, clone its shape with new prompt
  if (imageJobs[0]?.rawSnippet) {
    const first = items.find((j) => (j.id || j.job_id) === imageJobs[0].id) || items[0]
    if (first) {
      const clone = {
        public_model_key: first.public_model_key || first.metadata?.public_model_key || 'image1_pro',
        capability_key: first.capability_key || 'image.generate.v1',
        prompt: PROMPT,
        aspect_ratio: first.aspect_ratio || first.requested_options?.aspect || 'landscape',
        width: first.width || first.requested_options?.width || 2304,
        height: first.height || first.requested_options?.height || 1280,
        prompt_enhancement: true,
        metadata: {
          ...(first.metadata || {}),
          prompt: PROMPT,
          generation_thread_id: threadId + 'clone',
        },
        requested_options: {
          ...(first.requested_options || {}),
          prompt: PROMPT,
        },
      }
      // strip server-only fields if any leaked
      delete clone.metadata.id
      delete clone.metadata.status
      variants.unshift({ name: 'clone_recent_job_shape', body: clone })
    }
  }

  const posts = []
  for (const v of variants) {
    const r = await api(t, 'POST', '/v1/jobs', v.body)
    posts.push({
      name: v.name,
      status: r.status,
      ok: r.ok,
      error:
        (typeof r.data.message === 'string' && r.data.message) ||
        (typeof r.data.error === 'string' && r.data.error) ||
        undefined,
      jobId: r.data.id || r.data.job_id,
      detail: JSON.stringify(r.data).slice(0, 400),
    })
    await new Promise((x) => setTimeout(x, 600))
  }

  console.log(
    JSON.stringify(
      {
        meOk: me.ok,
        meStatus: me.status,
        jobsOk: jobs.ok,
        jobsCount: items.length,
        imageJobs,
        posts,
      },
      null,
      2,
    ),
  )
  app.exit(0)
})
