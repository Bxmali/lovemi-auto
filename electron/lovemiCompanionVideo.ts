/**
 * Companion 对话逼出角色绑定视频（会进 characters/{id}/assets）
 * 流程：确保 lab_proj → PATCH media_preferences → POST messages → 轮询角色资产里的 video
 */
import { randomUUID } from 'node:crypto'
import { fetch as undiciFetch } from 'undici'
import { dispatcherFor } from './mailProbe'
import { loadCreateCharSecrets } from './createCharSecrets'
import { appendConsoleLog } from './consoleDb'
import { acceptVisualReference, putCharacterPresentation, putPublicationDraft } from './lovemiPublish'
import { resolvePortraitAssetId } from './lovemiCreateChar'
import { pickAssetCdnUrl } from './lovemiMediaCache'

const LOVEMI = 'https://api.lovemi.ai'

function headers(token: string, extra?: Record<string, string>) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    Origin: 'https://app.lovemi.ai',
    Referer: 'https://app.lovemi.ai/',
    'Accept-Language': 'zh-CN',
    ...extra,
  }
}

function adminToken(fallback?: string) {
  const secrets = loadCreateCharSecrets()
  return secrets.adminSessionToken || fallback || ''
}

async function apiJson(input: {
  method: string
  path: string
  token: string
  proxyUrl: string
  body?: Record<string, unknown>
  extraHeaders?: Record<string, string>
}): Promise<{ ok: boolean; status: number; data: Record<string, unknown>; error?: string }> {
  const url = `${LOVEMI}${input.path}`
  try {
    const res = await undiciFetch(url, {
      method: input.method,
      headers: headers(input.token, {
        ...(input.body ? { 'Content-Type': 'application/json' } : {}),
        ...input.extraHeaders,
      }),
      body: input.body ? JSON.stringify(input.body) : undefined,
      dispatcher: dispatcherFor(input.proxyUrl, url),
      signal: AbortSignal.timeout(90_000),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const msg =
        (typeof data.message === 'string' && data.message) ||
        (typeof data.error === 'string' && data.error) ||
        (typeof data.detail === 'string' && data.detail) ||
        `HTTP ${res.status}`
      return { ok: false, status: res.status, data, error: msg }
    }
    return { ok: true, status: res.status, data }
  } catch (err) {
    return { ok: false, status: 0, data: {}, error: err instanceof Error ? err.message : String(err) }
  }
}

function pickLabId(data: Record<string, unknown>): string | undefined {
  if (typeof data.lab_project_id === 'string' && data.lab_project_id.startsWith('lab_proj_')) {
    return data.lab_project_id
  }
  if (typeof data.id === 'string' && data.id.startsWith('lab_proj_')) return data.id
  const items = data.items
  if (Array.isArray(items) && items[0] && typeof items[0] === 'object') {
    const first = items[0] as Record<string, unknown>
    if (typeof first.lab_project_id === 'string') return first.lab_project_id
  }
  return undefined
}

/** 查找或创建 companion lab_proj（绑定 character） */
export async function ensureCompanionLab(input: {
  characterId: string
  proxyUrl: string
  sessionToken?: string
  title?: string
}): Promise<{ ok: boolean; error?: string; labProjectId?: string }> {
  const token = adminToken(input.sessionToken)
  if (!token) return { ok: false, error: '缺少管理员 Bearer' }

  const list = await apiJson({
    method: 'GET',
    path: `/v1/lab-projects?character_id=${encodeURIComponent(input.characterId)}&lab_app_key=companion`,
    token,
    proxyUrl: input.proxyUrl,
  })
  if (list.ok) {
    const existing = pickLabId(list.data)
    if (existing) return { ok: true, labProjectId: existing }
  }

  const created = await apiJson({
    method: 'POST',
    path: '/v1/lab-projects',
    token,
    proxyUrl: input.proxyUrl,
    body: {
      title: input.title || 'companion',
      lab_app_key: 'companion',
      character_ids: [input.characterId],
    },
  })
  if (!created.ok) return { ok: false, error: created.error || '创建 lab_proj 失败' }
  const labId = pickLabId(created.data)
  if (!labId) return { ok: false, error: '创建成功但未返回 lab_project_id' }
  appendConsoleLog({
    level: 'info',
    action: 'create_char',
    message: `已创建 companion lab · ${labId}`,
  })
  return { ok: true, labProjectId: labId }
}

export async function setCompanionMediaPreferences(input: {
  labProjectId: string
  proxyUrl: string
  sessionToken?: string
}): Promise<{ ok: boolean; error?: string }> {
  const token = adminToken(input.sessionToken)
  if (!token) return { ok: false, error: '缺少管理员 Bearer' }
  const res = await apiJson({
    method: 'PATCH',
    path: `/v1/lab-projects/${encodeURIComponent(input.labProjectId)}/companion/contact`,
    token,
    proxyUrl: input.proxyUrl,
    body: {
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
    },
  })
  return res.ok ? { ok: true } : { ok: false, error: res.error }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function isNoRefVideoError(text: string) {
  return /没有可用于视频生成的参考图|视频暂时无法发送|no .*reference.*(image|asset)|reference image/i.test(
    text,
  )
}

function isVideoStillGenerating(text: string) {
  return /正在发送视频|generating video|video.*in progress|image\.edit|video\.image_to_video|still being processed/i.test(
    text,
  )
}

/** 瞬时错误：应等待/重试，不要立刻放弃整条流水线 */
function isTransientCompanionError(text: string) {
  return /still being processed|already (being )?processed|in progress|too many|rate.?limit|429|502|503|504|timeout|ETIMEDOUT|ECONNRESET|fetch failed|socket|temporarily|busy|try again|请稍后再试|稍后重试/i.test(
    text,
  )
}

/** 拉角色资产里最新一条视频（站内已有、软件没回填时用） */
export async function fetchLatestCharacterVideo(input: {
  characterId: string
  proxyUrl: string
  sessionToken?: string
  /** 若提供则优先返回不在此集合内的新视频 */
  excludeAssetIds?: string[]
}): Promise<{
  ok: boolean
  error?: string
  videoAssetId?: string
  cdnUrl?: string
}> {
  const token = adminToken(input.sessionToken)
  if (!token) return { ok: false, error: '缺少管理员 Bearer' }
  const exclude = new Set(input.excludeAssetIds || [])

  for (const scope of ['active', 'all'] as const) {
    const assets = await apiJson({
      method: 'GET',
      path: `/v1/characters/${encodeURIComponent(input.characterId)}/assets?scope=${scope}`,
      token,
      proxyUrl: input.proxyUrl,
    })
    if (!assets.ok) continue
    const items = Array.isArray(assets.data.items)
      ? (assets.data.items as Record<string, unknown>[])
      : []
    const videos = items.filter(
      (it) =>
        String(it.asset_kind || '').includes('video') &&
        typeof it.asset_id === 'string' &&
        String(it.asset_id).startsWith('asset_'),
    )
    const preferred =
      videos.find((it) => !exclude.has(String(it.asset_id))) || videos[0]
    if (!preferred?.asset_id) continue
    let cdnUrl = pickAssetCdnUrl(preferred)
    if (!cdnUrl) {
      const one = await apiJson({
        method: 'GET',
        path: `/v1/assets/${encodeURIComponent(String(preferred.asset_id))}`,
        token,
        proxyUrl: input.proxyUrl,
      })
      if (one.ok) cdnUrl = pickAssetCdnUrl(one.data)
    }
    return { ok: true, videoAssetId: String(preferred.asset_id), cdnUrl }
  }
  return { ok: false, error: '角色资产里还没有视频' }
}

/** 先 accept 立绘 + presentation 封面（可选写发布草稿封面），让 companion 有头像/参考图 */
async function prepareCharacterCover(input: {
  characterId: string
  proxyUrl: string
  token: string
  coverAssetId?: string
  title?: string
  /** 重试时不要清掉已有动态视频 */
  clearMotionAsset?: boolean
}): Promise<{ ok: boolean; error?: string; coverAssetId?: string }> {
  let coverId = input.coverAssetId
  if (!coverId) {
    const resolved = await resolvePortraitAssetId({
      characterId: input.characterId,
      sessionToken: input.token,
      proxyUrl: input.proxyUrl,
    })
    if (!resolved.ok || !resolved.assetId) {
      return { ok: false, error: resolved.error || '找不到立绘 asset，无法设封面' }
    }
    coverId = resolved.assetId
  }

  await acceptVisualReference({
    characterId: input.characterId,
    assetId: coverId,
    proxyUrl: input.proxyUrl,
    sessionToken: input.token,
  })

  const pres = await putCharacterPresentation({
    characterId: input.characterId,
    proxyUrl: input.proxyUrl,
    sessionToken: input.token,
    coverAssetId: coverId,
    clearMotionAsset: input.clearMotionAsset === true,
  })
  if (!pres.ok) {
    return { ok: false, error: pres.error || '设 presentation 封面失败', coverAssetId: coverId }
  }

  // 发布草稿封面（对话/listing 预览用）
  await putPublicationDraft({
    characterId: input.characterId,
    proxyUrl: input.proxyUrl,
    sessionToken: input.token,
    body: {
      listing_type: 'character_listing',
      title: input.title || '角色',
      description: '',
      adult_content: true,
      clear_cover_asset: false,
      clear_description: false,
      content_rating: 'adult',
      cover_asset_id: coverId,
      preview_mode: 'full',
      price_coins: 0,
      pricing_mode: 'free',
      supported_lab_apps: ['companion', 'intimacy_lab', 'galgame', 'adult_film_director'],
      tags: [],
    },
  })

  appendConsoleLog({
    level: 'info',
    action: 'create_char',
    message: `已设封面参考图 ${coverId} · 等待生效后再发消息`,
  })
  // 给服务端同步头像/参考图一点时间，避免紧接着发消息报「没有参考图」
  // 三槽并发时更要等久一点
  await sleep(9000)
  return { ok: true, coverAssetId: coverId }
}

/**
 * 发 companion 消息逼出视频（需 Idempotency-Key）
 * 先设 presentation/draft 封面，再发消息；遇「没有参考图」自动重试
 */
export async function requestCompanionMotionVideo(input: {
  characterId: string
  proxyUrl: string
  sessionToken?: string
  prompt?: string
  labProjectId?: string
  title?: string
  coverAssetId?: string
  timeoutMs?: number
}): Promise<{
  ok: boolean
  error?: string
  labProjectId?: string
  videoAssetId?: string
  cdnUrl?: string
  jobIds?: string[]
  coverAssetId?: string
}> {
  const token = adminToken(input.sessionToken)
  if (!token) return { ok: false, error: '缺少管理员 Bearer' }

  const prepared = await prepareCharacterCover({
    characterId: input.characterId,
    proxyUrl: input.proxyUrl,
    token,
    coverAssetId: input.coverAssetId,
    title: input.title,
    clearMotionAsset: true,
  })
  if (!prepared.ok) {
    return { ok: false, error: prepared.error || '设封面失败', coverAssetId: prepared.coverAssetId }
  }

  let labId = input.labProjectId
  if (!labId) {
    appendConsoleLog({
      level: 'info',
      action: 'create_char',
      message: `companion 查找/创建 lab · ${input.characterId.slice(0, 18)}`,
    })
    const lab = await ensureCompanionLab({
      characterId: input.characterId,
      proxyUrl: input.proxyUrl,
      sessionToken: token,
      title: input.title,
    })
    if (!lab.ok || !lab.labProjectId) return { ok: false, error: lab.error || '无 lab_proj' }
    labId = lab.labProjectId
  }

  await setCompanionMediaPreferences({
    labProjectId: labId,
    proxyUrl: input.proxyUrl,
    sessionToken: token,
  })

  const before = await apiJson({
    method: 'GET',
    path: `/v1/characters/${encodeURIComponent(input.characterId)}/assets?scope=active`,
    token,
    proxyUrl: input.proxyUrl,
  })
  const beforeVideos = new Set(
    (Array.isArray(before.data.items) ? (before.data.items as Record<string, unknown>[]) : [])
      .filter((it) => String(it.asset_kind || '').includes('video'))
      .map((it) => String(it.asset_id || '')),
  )

  const prompt = (input.prompt || '想看你自慰视频').trim()
  const timeoutMs = input.timeoutMs ?? 600_000
  const jobIds = new Set<string>()
  const collectJobs = (obj: unknown) => {
    const s = JSON.stringify(obj)
    for (const m of s.matchAll(/job_[a-f0-9]+/g)) jobIds.add(m[0])
  }

  const trySalvage = async () =>
    fetchLatestCharacterVideo({
      characterId: input.characterId,
      proxyUrl: input.proxyUrl,
      sessionToken: token,
      excludeAssetIds: [...beforeVideos],
    })

  // 无参考图 / still being processed / 网络瞬时错误 → 等待捞视频或重试发消息
  const maxAttempts = 6
  let lastFailReason = ''
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      const reasonHint = lastFailReason || '重试'
      appendConsoleLog({
        level: 'warn',
        action: 'create_char',
        message: `companion 重试发消息 ${attempt}/${maxAttempts} · ${reasonHint.slice(0, 80)}`,
      })
      // 无参考图才重设封面；「仍在处理」只等待，避免清掉进行中的生成
      if (isNoRefVideoError(lastFailReason)) {
        await prepareCharacterCover({
          characterId: input.characterId,
          proxyUrl: input.proxyUrl,
          token,
          coverAssetId: prepared.coverAssetId,
          title: input.title,
          clearMotionAsset: false,
        })
      }
      await sleep(Math.min(45_000, 6000 * attempt))
      // 重试前先捞：上一次可能已经发出去了，只是报了 still processing
      const early = await trySalvage()
      if (early.ok && early.videoAssetId) {
        appendConsoleLog({
          level: 'info',
          action: 'create_char',
          message: `companion 重试前已捞回站内视频 · ${early.videoAssetId}`,
        })
        return {
          ok: true,
          labProjectId: labId,
          videoAssetId: early.videoAssetId,
          cdnUrl: early.cdnUrl,
          jobIds: [...jobIds],
          coverAssetId: prepared.coverAssetId,
        }
      }
    }

    appendConsoleLog({
      level: 'info',
      action: 'create_char',
      message: `companion 即将发消息 · ${input.characterId.slice(0, 18)} · attempt ${attempt}`,
    })
    const idem = `companion-msg:${randomUUID()}`
    const msg = await apiJson({
      method: 'POST',
      path: `/v1/lab-projects/${encodeURIComponent(labId)}/companion/messages`,
      token,
      proxyUrl: input.proxyUrl,
      body: {
        content: prompt,
        asset_ids: [],
        interaction: { kind: 'message', audience: 'group', target_character_ids: [] },
      },
      extraHeaders: { 'Idempotency-Key': idem },
    })
    if (!msg.ok) {
      const errText = msg.error || JSON.stringify(msg.data)
      lastFailReason = errText
      const canRetry =
        attempt < maxAttempts &&
        (isNoRefVideoError(errText) || isTransientCompanionError(errText))
      if (canRetry) {
        // still being processed：先耐心等视频，不要立刻再 POST 刷消息
        if (isTransientCompanionError(errText) && !isNoRefVideoError(errText)) {
          appendConsoleLog({
            level: 'warn',
            action: 'create_char',
            message: `companion 瞬时失败，先等待捞视频 · ${errText.slice(0, 100)}`,
          })
          const waitUntil = Date.now() + Math.min(120_000, 20_000 * attempt)
          while (Date.now() < waitUntil) {
            const mid = await trySalvage()
            if (mid.ok && mid.videoAssetId) {
              appendConsoleLog({
                level: 'info',
                action: 'create_char',
                message: `companion 等待中捞回视频 · ${mid.videoAssetId}`,
              })
              return {
                ok: true,
                labProjectId: labId,
                videoAssetId: mid.videoAssetId,
                cdnUrl: mid.cdnUrl,
                jobIds: [...jobIds],
                coverAssetId: prepared.coverAssetId,
              }
            }
            await sleep(4000)
          }
        }
        continue
      }
      const salvage = await trySalvage()
      if (salvage.ok && salvage.videoAssetId) {
        appendConsoleLog({
          level: 'info',
          action: 'create_char',
          message: `companion 发消息失败但已捞回站内视频 · ${salvage.videoAssetId}`,
        })
        return {
          ok: true,
          labProjectId: labId,
          videoAssetId: salvage.videoAssetId,
          cdnUrl: salvage.cdnUrl,
          jobIds: [...jobIds],
          coverAssetId: prepared.coverAssetId,
        }
      }
      appendConsoleLog({
        level: 'error',
        action: 'create_char',
        message: `companion 发消息失败 · ${input.characterId.slice(0, 18)} · ${msg.error || ''}`,
      })
      return {
        ok: false,
        error: msg.error || '发送 companion 消息失败',
        labProjectId: labId,
        coverAssetId: prepared.coverAssetId,
      }
    }

    lastFailReason = ''
    appendConsoleLog({
      level: 'info',
      action: 'create_char',
      message: `已发 companion 消息逼视频 · ${labId}${attempt > 1 ? ` · 第 ${attempt} 次` : ''}`,
    })
    collectJobs(msg.data)

    const started = Date.now()
    let sawNoRefError = false
    let lastThreadHint = ''
    let lastHeartbeat = 0
    while (Date.now() - started < timeoutMs) {
      const elapsed = Date.now() - started
      if (elapsed - lastHeartbeat >= 15_000) {
        lastHeartbeat = elapsed
        appendConsoleLog({
          level: 'info',
          action: 'create_char',
          message: `companion 等待视频中 · ${input.characterId.slice(0, 18)} · ${Math.floor(elapsed / 1000)}s`,
        })
      }
      const assets = await apiJson({
        method: 'GET',
        path: `/v1/characters/${encodeURIComponent(input.characterId)}/assets?scope=active`,
        token,
        proxyUrl: input.proxyUrl,
      })
      const items = Array.isArray(assets.data.items)
        ? (assets.data.items as Record<string, unknown>[])
        : []
      const videos = items.filter(
        (it) =>
          String(it.asset_kind || '').includes('video') &&
          typeof it.asset_id === 'string' &&
          String(it.asset_id).startsWith('asset_'),
      )
      const newest = videos.find((it) => !beforeVideos.has(String(it.asset_id)))
      if (newest?.asset_id) {
        let cdnUrl = pickAssetCdnUrl(newest)
        if (!cdnUrl) {
          const one = await apiJson({
            method: 'GET',
            path: `/v1/assets/${encodeURIComponent(String(newest.asset_id))}`,
            token,
            proxyUrl: input.proxyUrl,
          })
          if (one.ok) cdnUrl = pickAssetCdnUrl(one.data)
        }
        appendConsoleLog({
          level: 'info',
          action: 'create_char',
          message: `companion 视频已入角色资产 · ${String(newest.asset_id)}${cdnUrl ? ' · 已取 CDN' : ' · 暂无 CDN'}`,
        })
        return {
          ok: true,
          labProjectId: labId,
          videoAssetId: String(newest.asset_id),
          cdnUrl,
          jobIds: [...jobIds],
          coverAssetId: prepared.coverAssetId,
        }
      }

      const thread = await apiJson({
        method: 'GET',
        path: `/v1/lab-projects/${encodeURIComponent(labId)}/companion/messages?limit=12`,
        token,
        proxyUrl: input.proxyUrl,
      })
      if (thread.ok) {
        collectJobs(thread.data)
        const threadText = JSON.stringify(thread.data)
        lastThreadHint = threadText.slice(0, 200)
        if (isNoRefVideoError(threadText)) {
          // 前 90 秒内继续等（三槽并发时封面同步更慢）
          if (!isVideoStillGenerating(threadText) && elapsed > 90_000) {
            sawNoRefError = true
            lastFailReason = '没有可用于视频生成的参考图'
            break
          }
        }
      }
      await sleep(2500)
    }

    if (sawNoRefError && attempt < maxAttempts) continue

    const salvage = await trySalvage()
    if (salvage.ok && salvage.videoAssetId) {
      appendConsoleLog({
        level: 'info',
        action: 'create_char',
        message: `companion 等待结束但已捞回站内视频 · ${salvage.videoAssetId}`,
      })
      return {
        ok: true,
        labProjectId: labId,
        videoAssetId: salvage.videoAssetId,
        cdnUrl: salvage.cdnUrl,
        jobIds: [...jobIds],
        coverAssetId: prepared.coverAssetId,
      }
    }

    if (attempt < maxAttempts && (sawNoRefError || isTransientCompanionError(lastFailReason))) {
      continue
    }

    const errMsg = sawNoRefError
      ? '角色仍无视频参考图（已重试设封面）'
      : `等待 companion 视频超时${lastThreadHint ? ' · 对话仍在生成中或未产出视频' : ''}`
    appendConsoleLog({
      level: 'error',
      action: 'create_char',
      message: `companion 失败 · ${input.characterId.slice(0, 18)} · ${errMsg}`,
    })
    return {
      ok: false,
      error: errMsg,
      labProjectId: labId,
      jobIds: [...jobIds],
      coverAssetId: prepared.coverAssetId,
    }
  }

  const salvage = await trySalvage()
  if (salvage.ok && salvage.videoAssetId) {
    return {
      ok: true,
      labProjectId: labId,
      videoAssetId: salvage.videoAssetId,
      cdnUrl: salvage.cdnUrl,
      jobIds: [...jobIds],
      coverAssetId: prepared.coverAssetId,
    }
  }
  appendConsoleLog({
    level: 'error',
    action: 'create_char',
    message: `companion 失败 · ${input.characterId.slice(0, 18)} · 重试已用尽`,
  })
  return {
    ok: false,
    error: '等待 companion 视频失败（重试已用尽）',
    labProjectId: labId,
    jobIds: [...jobIds],
    coverAssetId: prepared.coverAssetId,
  }
}
