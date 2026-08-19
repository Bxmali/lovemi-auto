/**
 * 一键流水线：
 * - autoVideoAndPublish：Teamo 出诱惑向 5s 动态提示词 → companion messages → presentation → 发布
 * - fullAutoToPublish：参考图分析 → 创建+立绘 → 同上
 */
import { fetch as undiciFetch } from 'undici'
import { dispatcherFor } from './mailProbe'
import { loadCreateCharSecrets } from './createCharSecrets'
import { appendConsoleLog } from './consoleDb'
import {
  analyzeReferenceImage,
  createLovemiCharacter,
  resolvePortraitAssetId,
  waitLovemiPortrait,
} from './lovemiCreateChar'
import { requestCompanionMotionVideo, fetchLatestCharacterVideo } from './lovemiCompanionVideo'
import { acceptVisualReference, setPreviewAndMaybePublish } from './lovemiPublish'

const MOTION_PROMPT_SYSTEM = `你是成人向短视频导演，专为 Lovemi companion「催视频」写中文提示词。
根据立绘/角色气质，输出一段**可直接发给 companion 的催视频文案+画面指令**（或纯画面提示词均可），用于生成约 5 秒竖屏动态预览。

硬性要求：
- 角色一律视为**已确认年满 21 岁的成年女性**；禁止任何未成年/幼态/学生制服暗示
- 中文；约 80–220 字；只返回提示词正文，不要 JSON、不要引号包裹、不要解释、不要拒写说教
- 感觉：很诱惑、暧昧、呼吸感、发丝轻晃、眼神勾人、身体微动；写真级真实感；成人内容允许
- 时长与构图暗示：5 秒、9:16 竖屏、半身或近景
- 禁止：换脸、夸张变形、瞬移、文字水印、多镜头硬切、年龄相关敏感词
- 若角色为东亚/中日韩：必须反复写「东亚面孔/中日韩五官」，禁止跑成欧美脸；强化娇羞粘人、欲拒还迎
- 若偏写实西式：高级冷感欲感，保持参考身份`

function isMotionPromptRefusal(text: string): boolean {
  return /不能帮你|无法协助|我不能|拒[绝写]|未成年|近未成年|underage|as an ai|i can'?t|i cannot|sorry,? i/i.test(
    text,
  )
}

const FALLBACK_MOTION_PROMPT =
  '5秒竖屏9:16，半身近景，写真级真实感。成年东亚女性，发丝轻晃，呼吸起伏，眼神勾人，嘴角微扬，肩线与锁骨随呼吸微动，暧昧欲感，镜头轻微推进，禁止换脸变形。'

function teamoHeaders(apiKey: string) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  }
}

function messageContentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>
          if (typeof p.text === 'string') return p.text
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/** 中转站：根据立绘（或参考图）生成诱惑向 5s 动态视频提示词 */
export async function generateSeductiveMotionPrompt(input: {
  proxyUrl: string
  imageBase64?: string
  mimeType?: string
  imageDataUrl?: string
  characterHint?: string
  appearanceHint?: string
}): Promise<{ ok: boolean; error?: string; prompt?: string; model?: string }> {
  const secrets = loadCreateCharSecrets()
  if (!secrets.teamoApiKey) return { ok: false, error: '未配置中转站 API Key' }
  if (!input.proxyUrl) return { ok: false, error: '未配置出站代理' }

  let dataUrl = input.imageDataUrl || ''
  if (!dataUrl && input.imageBase64) {
    dataUrl = `data:${input.mimeType || 'image/png'};base64,${input.imageBase64}`
  }
  // 无图也可纯文案催视频（有外观摘要/角色提示时），避免卡死整条流水线

  const url = `${secrets.teamoApiBase.replace(/\/$/, '')}/chat/completions`
  const userText = [
    dataUrl
      ? '请根据这张角色立绘，写催视频/动态预览提示词。'
      : '没有可用立绘图，请根据文字描述写催视频/动态预览提示词。',
    input.characterHint ? `角色补充：${input.characterHint}` : '',
    input.appearanceHint ? `外观摘要：${input.appearanceHint}` : '',
    /东亚|中日韩|华裔|日系|韩系|萌妹|east.?asian/i.test(
      `${input.characterHint || ''} ${input.appearanceHint || ''}`,
    )
      ? '【东亚锁】画面必须是东亚中日韩面孔，禁止欧美五官跑偏；提示词里写明东亚。'
      : '',
    /脚|足|脚掌|脚心|丝袜|蕾丝袜|裤袜/.test(input.appearanceHint || '')
      ? '【足部锁】参考有脚则动态里也要保留脚部前景/脚掌朝向/袜足细节，禁止省略脚或乱加高跟鞋。'
      : '',
  ]
    .filter(Boolean)
    .join('\n')

  if (!dataUrl && !input.characterHint && !input.appearanceHint) {
    return { ok: false, error: '缺少立绘/参考图与角色描述（无法向中转站要动态提示词）' }
  }

  try {
    const res = await undiciFetch(url, {
      method: 'POST',
      headers: teamoHeaders(secrets.teamoApiKey),
      dispatcher: dispatcherFor(input.proxyUrl, url),
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model: secrets.teamoModel || 'gpt-5.4-mini',
        temperature: 0.7,
        messages: [
          { role: 'system', content: MOTION_PROMPT_SYSTEM },
          dataUrl
            ? {
                role: 'user',
                content: [
                  { type: 'text', text: userText },
                  { type: 'image_url', image_url: { url: dataUrl } },
                ],
              }
            : { role: 'user', content: userText },
        ],
      }),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const errObj = data.error as { message?: string } | string | undefined
      const msg =
        (typeof errObj === 'object' && errObj?.message) ||
        (typeof errObj === 'string' && errObj) ||
        (typeof data.message === 'string' && data.message) ||
        `中转站 HTTP ${res.status}`
      return { ok: false, error: msg, model: secrets.teamoModel }
    }
    const choices = Array.isArray(data.choices) ? (data.choices as Array<Record<string, unknown>>) : []
    const msg0 = (choices[0]?.message || {}) as Record<string, unknown>
    let text = messageContentToText(msg0.content).trim()
    if (!text) text = messageContentToText(msg0.reasoning_content).trim()
    text = text.replace(/^["「]|["」]$/g, '').trim()
    if (!text) return { ok: false, error: '中转站未返回动态提示词', model: secrets.teamoModel }
    if (isMotionPromptRefusal(text)) {
      appendConsoleLog({
        level: 'warn',
        action: 'create_char',
        message: `Teamo 拒写动态提示词，改用兜底文案 · ${text.slice(0, 48)}…`,
      })
      return { ok: true, prompt: FALLBACK_MOTION_PROMPT, model: secrets.teamoModel }
    }
    appendConsoleLog({
      level: 'info',
      action: 'create_char',
      message: `Teamo 动态提示词已生成 · ${text.slice(0, 40)}…`,
    })
    return { ok: true, prompt: text, model: secrets.teamoModel }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function fetchImageAsDataUrl(input: {
  cdnUrl: string
  proxyUrl: string
}): Promise<string | undefined> {
  try {
    const res = await undiciFetch(input.cdnUrl, {
      dispatcher: dispatcherFor(input.proxyUrl, input.cdnUrl),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) return undefined
    const buf = Buffer.from(await res.arrayBuffer())
    const ct = res.headers.get('content-type') || 'image/jpeg'
    return `data:${ct.split(';')[0]};base64,${buf.toString('base64')}`
  } catch {
    return undefined
  }
}

function buildPublishMeta(payload?: Record<string, unknown>, fallbackHint?: string) {
  let title = '未命名角色'
  let description = fallbackHint || ''
  if (payload) {
    if (typeof payload.display_name === 'string' && payload.display_name.trim()) {
      title = payload.display_name.trim()
      const age =
        typeof payload.age_statement === 'string'
          ? payload.age_statement.replace(/[^\d]/g, '')
          : ''
      if (age) title = `${title} · ${age}`
    }
    const profile = typeof payload.profile_text === 'string' ? payload.profile_text : ''
    const personality = Array.isArray(payload.personality_tags)
      ? payload.personality_tags.map(String).join('；')
      : ''
    description = [profile, personality].filter(Boolean).join('\n') || description || title
  }
  return { title, description }
}

/**
 * 已有角色+立绘：Teamo 提示词 → companion 视频（仅生成，不发布）
 */
export async function generateMotionVideoOnly(input: {
  characterId: string
  proxyUrl: string
  sessionToken?: string
  portraitCdnUrl?: string
  imageBase64?: string
  mimeType?: string
  imageDataUrl?: string
  coverAssetId?: string
  characterHint?: string
  appearanceHint?: string
}): Promise<{
  ok: boolean
  error?: string
  motionPrompt?: string
  coverAssetId?: string
  videoAssetId?: string
  cdnUrl?: string
  labProjectId?: string
}> {
  const secrets = loadCreateCharSecrets()
  const token = secrets.adminSessionToken || input.sessionToken || ''
  if (!token) return { ok: false, error: '缺少管理员 Bearer' }

  let coverId = input.coverAssetId
  let portraitDataUrl: string | undefined = input.imageDataUrl
  if (!portraitDataUrl && input.imageBase64) {
    portraitDataUrl = `data:${input.mimeType || 'image/png'};base64,${input.imageBase64}`
  }
  if (!coverId || !portraitDataUrl) {
    const resolved = await resolvePortraitAssetId({
      characterId: input.characterId,
      sessionToken: token,
      proxyUrl: input.proxyUrl,
      retries: 5,
    })
    if (resolved.ok && resolved.assetId) coverId = coverId || resolved.assetId
    if (!portraitDataUrl && resolved.cdnUrl) {
      portraitDataUrl = await fetchImageAsDataUrl({
        cdnUrl: resolved.cdnUrl,
        proxyUrl: input.proxyUrl,
      })
    }
  }
  if (!portraitDataUrl && input.portraitCdnUrl) {
    portraitDataUrl = await fetchImageAsDataUrl({
      cdnUrl: input.portraitCdnUrl,
      proxyUrl: input.proxyUrl,
    })
  }
  if (!coverId) return { ok: false, error: '找不到立绘 asset_id（请先生成立绘）' }

  const gen = await generateSeductiveMotionPrompt({
    proxyUrl: input.proxyUrl,
    imageDataUrl: portraitDataUrl,
    characterHint: input.characterHint,
    appearanceHint: input.appearanceHint,
  })
  if (!gen.ok || !gen.prompt) {
    return { ok: false, error: gen.error || 'Teamo 动态提示词失败', coverAssetId: coverId }
  }

  const video = await requestCompanionMotionVideo({
    characterId: input.characterId,
    sessionToken: token,
    proxyUrl: input.proxyUrl,
    prompt: gen.prompt,
    title: input.characterHint || 'companion',
    coverAssetId: coverId,
    timeoutMs: 600_000,
  })
  if (!video.ok || !video.videoAssetId) {
    return {
      ok: false,
      error: video.error || 'companion 视频失败',
      motionPrompt: gen.prompt,
      coverAssetId: coverId,
      labProjectId: video.labProjectId,
    }
  }

  return {
    ok: true,
    motionPrompt: gen.prompt,
    coverAssetId: coverId,
    videoAssetId: video.videoAssetId,
    cdnUrl: video.cdnUrl,
    labProjectId: video.labProjectId,
  }
}

/**
 * 已有角色+立绘：Teamo 提示词 → companion 视频 → accept+presentation → 发布
 */
export async function autoVideoAndPublish(input: {
  characterId: string
  proxyUrl: string
  sessionToken?: string
  /** 立绘 CDN 或参考图 data URL / base64 */
  portraitCdnUrl?: string
  imageBase64?: string
  mimeType?: string
  imageDataUrl?: string
  coverAssetId?: string
  characterHint?: string
  appearanceHint?: string
  payload?: Record<string, unknown>
  motionPromptOverride?: string
}): Promise<{
  ok: boolean
  error?: string
  motionPrompt?: string
  coverAssetId?: string
  videoAssetId?: string
  cdnUrl?: string
  listingId?: string
  labProjectId?: string
  publishOk?: boolean
}> {
  const secrets = loadCreateCharSecrets()
  const token = secrets.adminSessionToken || input.sessionToken || ''
  if (!token) return { ok: false, error: '缺少管理员 Bearer' }

  // cover asset：优先立绘 CDN；有现成 motion 提示词时可跳过下图
  let coverId = input.coverAssetId
  let portraitCdn = input.portraitCdnUrl
  let portraitDataUrl: string | undefined = input.imageDataUrl
  if (!coverId || (!portraitCdn && !portraitDataUrl)) {
    const resolved = await resolvePortraitAssetId({
      characterId: input.characterId,
      sessionToken: token,
      proxyUrl: input.proxyUrl,
      retries: 8,
    })
    if (resolved.ok && resolved.assetId) coverId = coverId || resolved.assetId
    if (!portraitCdn && resolved.cdnUrl) portraitCdn = resolved.cdnUrl
  }
  if (!coverId) return { ok: false, error: '找不到立绘 asset_id（请先生成立绘）' }

  // 1) Teamo motion prompt
  let motionPrompt = (input.motionPromptOverride || '').trim()
  if (!motionPrompt) {
    if (!portraitDataUrl && portraitCdn) {
      portraitDataUrl = await fetchImageAsDataUrl({
        cdnUrl: portraitCdn,
        proxyUrl: input.proxyUrl,
      })
    }
    if (!portraitDataUrl && input.imageBase64) {
      portraitDataUrl = `data:${input.mimeType || 'image/png'};base64,${input.imageBase64}`
    }
    const gen = await generateSeductiveMotionPrompt({
      proxyUrl: input.proxyUrl,
      imageDataUrl: portraitDataUrl,
      characterHint: input.characterHint,
      appearanceHint: input.appearanceHint,
    })
    if (!gen.ok || !gen.prompt) {
      return { ok: false, error: gen.error || 'Teamo 动态提示词失败', coverAssetId: coverId }
    }
    motionPrompt = gen.prompt
  }

  // 2) companion messages → character-bound video
  const video = await requestCompanionMotionVideo({
    characterId: input.characterId,
    sessionToken: token,
    proxyUrl: input.proxyUrl,
    prompt: motionPrompt,
    title: String(input.payload?.display_name || 'companion'),
    coverAssetId: coverId,
  })
  let videoAssetId = video.videoAssetId
  let videoCdn = video.cdnUrl
  if (!video.ok || !videoAssetId) {
    const salvage = await fetchLatestCharacterVideo({
      characterId: input.characterId,
      proxyUrl: input.proxyUrl,
      sessionToken: token,
    })
    if (salvage.ok && salvage.videoAssetId) {
      appendConsoleLog({
        level: 'info',
        action: 'create_char',
        message: `自动视频：companion 报失败但站内已有视频，继续发布 · ${salvage.videoAssetId}`,
      })
      videoAssetId = salvage.videoAssetId
      videoCdn = salvage.cdnUrl
    } else {
      return {
        ok: false,
        error: video.error || 'companion 视频失败',
        motionPrompt,
        coverAssetId: coverId,
        labProjectId: video.labProjectId,
      }
    }
  }

  // 3) accept + presentation + draft + publish
  await acceptVisualReference({
    characterId: input.characterId,
    assetId: coverId,
    proxyUrl: input.proxyUrl,
    sessionToken: token,
  })
  const { title, description } = buildPublishMeta(input.payload, input.characterHint)
  const pub = await setPreviewAndMaybePublish({
    characterId: input.characterId,
    proxyUrl: input.proxyUrl,
    sessionToken: token,
    coverAssetId: coverId,
    videoAssetId,
    title,
    description,
    publish: true,
  })
  if (!pub.ok) {
    return {
      ok: false,
      error: pub.error || '设预览/发布失败',
      motionPrompt,
      coverAssetId: coverId,
      videoAssetId,
      cdnUrl: videoCdn,
      listingId: pub.listingId,
      labProjectId: video.labProjectId,
      publishOk: false,
    }
  }

  appendConsoleLog({
    level: 'info',
    action: 'create_char',
    message: `自动视频并发布完成 · ${input.characterId.slice(0, 18)} · ${pub.listingId || ''}`,
  })
  return {
    ok: true,
    motionPrompt,
    coverAssetId: coverId,
    videoAssetId,
    cdnUrl: videoCdn,
    listingId: pub.listingId,
    labProjectId: video.labProjectId,
    publishOk: true,
  }
}

/** 参考图 → 分析 JSON → 创建+立绘 → 视频+发布 */
export async function fullAutoToPublish(input: {
  imageBase64: string
  mimeType?: string
  proxyUrl: string
  sessionToken?: string
  userHint?: string
  onProgress?: (p: {
    stage: string
    characterId?: string
    portraitCdnUrl?: string
    coverAssetId?: string
    payload?: Record<string, unknown>
    portraitPrompt?: string
    motionPrompt?: string
    videoAssetId?: string
    videoCdnUrl?: string
    listingId?: string
  }) => void
}): Promise<{
  ok: boolean
  error?: string
  characterId?: string
  payload?: Record<string, unknown>
  portraitPrompt?: string
  motionPrompt?: string
  coverAssetId?: string
  videoAssetId?: string
  videoCdnUrl?: string
  listingId?: string
  portraitCdnUrl?: string
}> {
  const secrets = loadCreateCharSecrets()
  const token = secrets.adminSessionToken || input.sessionToken || ''
  if (!token) return { ok: false, error: '缺少管理员 Bearer' }
  const progress = input.onProgress || (() => {})

  progress({ stage: 'analyze' })
  const analyzed = await analyzeReferenceImage({
    imageBase64: input.imageBase64,
    mimeType: input.mimeType,
    proxyUrl: input.proxyUrl,
    userHint: input.userHint,
  })
  if (!analyzed.ok || !analyzed.payload) {
    return { ok: false, error: analyzed.error || '分析失败' }
  }
  progress({
    stage: 'analyzed',
    payload: analyzed.payload,
    portraitPrompt: analyzed.portraitPrompt,
  })

  progress({ stage: 'create' })
  const created = await createLovemiCharacter({
    sessionToken: token,
    proxyUrl: input.proxyUrl,
    body: analyzed.payload,
    waitPortrait: false,
  })
  const characterId =
    (created.data &&
      (typeof created.data.character_id === 'string'
        ? created.data.character_id
        : typeof created.data.id === 'string'
          ? created.data.id
          : undefined)) ||
    undefined
  if (!created.ok || !characterId) {
    return {
      ok: false,
      error: created.error || '创建角色失败',
      payload: analyzed.payload,
      portraitPrompt: analyzed.portraitPrompt,
      characterId,
    }
  }

  // 立刻回填角色 ID，前端可并行刷立绘（不必干等主进程）
  progress({
    stage: 'create',
    characterId,
    payload: analyzed.payload,
    portraitPrompt: analyzed.portraitPrompt,
  })

  const waited = await waitLovemiPortrait({
    characterId,
    sessionToken: token,
    proxyUrl: input.proxyUrl,
  })

  let portraitCdnUrl = waited.cdnUrl
  let coverAssetId: string | undefined = waited.assetId
  if (!portraitCdnUrl || !coverAssetId) {
    const resolved = await resolvePortraitAssetId({
      characterId,
      sessionToken: token,
      proxyUrl: input.proxyUrl,
      jobId: waited.jobId,
      retries: 8,
    })
    if (resolved.cdnUrl) portraitCdnUrl = portraitCdnUrl || resolved.cdnUrl
    if (resolved.assetId) coverAssetId = coverAssetId || resolved.assetId
  }
  if (!waited.ok && !portraitCdnUrl) {
    return {
      ok: false,
      error: waited.error || created.error || '立绘未就绪',
      characterId,
      payload: analyzed.payload,
      portraitPrompt: analyzed.portraitPrompt,
      portraitCdnUrl,
      coverAssetId,
    }
  }
  if (!coverAssetId) {
    return {
      ok: false,
      error: '立绘已出但找不到 asset_id（无法设封面/催视频）。请稍后点「生成动态视频」重试，或打开站内该角色确认立绘已接受。',
      characterId,
      payload: analyzed.payload,
      portraitPrompt: analyzed.portraitPrompt,
      portraitCdnUrl,
    }
  }
  progress({
    stage: 'portrait',
    characterId,
    portraitCdnUrl,
    coverAssetId,
    payload: analyzed.payload,
    portraitPrompt: analyzed.portraitPrompt,
  })

  const appearanceHint = Array.isArray(analyzed.payload.appearance_tags)
    ? analyzed.payload.appearance_tags.map(String).slice(0, 12).join('；')
    : ''

  progress({ stage: 'video', characterId, portraitCdnUrl, coverAssetId })
  // 只用立绘 CDN 做动态提示词；绝不用参考图 base64 顶替（否则视频像「另一张图」且易失败）
  const rest = await autoVideoAndPublish({
    characterId,
    proxyUrl: input.proxyUrl,
    sessionToken: token,
    portraitCdnUrl,
    coverAssetId,
    characterHint: input.userHint || String(analyzed.payload.display_name || ''),
    appearanceHint,
    payload: analyzed.payload,
  })

  progress({
    stage: rest.ok ? 'published' : 'video_failed',
    characterId,
    portraitCdnUrl,
    coverAssetId: rest.coverAssetId || coverAssetId,
    motionPrompt: rest.motionPrompt,
    videoAssetId: rest.videoAssetId,
    videoCdnUrl: rest.cdnUrl,
    listingId: rest.listingId,
    payload: analyzed.payload,
    portraitPrompt: analyzed.portraitPrompt,
  })

  return {
    ok: rest.ok,
    error: rest.error,
    characterId,
    payload: analyzed.payload,
    portraitPrompt: analyzed.portraitPrompt,
    motionPrompt: rest.motionPrompt,
    coverAssetId: rest.coverAssetId || coverAssetId,
    videoAssetId: rest.videoAssetId,
    videoCdnUrl: rest.cdnUrl,
    listingId: rest.listingId,
    portraitCdnUrl,
  }
}
