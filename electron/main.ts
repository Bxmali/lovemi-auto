import { app, BrowserWindow, dialog, ipcMain, protocol, net, session, type WebContents } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { probeAccount, probeAccountsBatch, testProxyConnectivity, type ProbeInput } from './mailProbe'
import { registerLovemiAccount, type RegisterInput } from './lovemiRegister'
import { loginLovemi, fetchLovemiMe, resetLovemiPassword, type LoginInput, type ResetPasswordInput } from './lovemiAuth'
import { getVlessStatus, resolveMailProxy, stopVlessBridge } from './vless/runner'
import { closeAccountsDb, loadAccountsJson, saveAccountsJson } from './accountsDb'
import {
  addCommentTemplate,
  addDisplayName,
  appendConsoleLog,
  characterStats,
  clearConsoleLogsView,
  copyLibraryStats,
  ensureCopyLibrariesSeeded,
  listCommentTemplates,
  listConsoleLogs,
  listDisplayNames,
  pickBalancedLocale,
  releaseWorkingActions,
  renameAccountProfile,
  runDiscoveryOnce,
  runEngageStep,
  type EngageAccount,
} from './consoleDb'
import { isLocale, type LocaleCode } from './locales'
import {
  createCharConfigPublic,
  loadCreateCharSecrets,
  saveCreateCharSecrets,
  type CreateCharSecrets,
} from './createCharSecrets'
import {
  analyzeReferenceImage,
  createLovemiCharacter,
  fetchCharacterPortraitPreview,
  generateMotionVideo,
  waitLovemiPortrait,
} from './lovemiCreateChar'
import { setPreviewAndMaybePublish } from './lovemiPublish'
import { requestCompanionMotionVideo, fetchLatestCharacterVideo } from './lovemiCompanionVideo'
import { autoVideoAndPublish, fullAutoToPublish, generateMotionVideoOnly } from './lovemiAutoPublish'
import { cacheLovemiCdnMedia, mediaCacheDir } from './lovemiMediaCache'
import { generateSocialCaption } from './lovemiCaptionGen'
import {
  cancelTgautoBatch,
  checkTgautoHealth,
  isTgautoBatchRunning,
  loadTgautoBridgeSettings,
  previewTgautoBatch,
  runTgautoBatchPost,
  saveTgautoBridgeSettings,
  type TgautoBatchProgress,
} from './tgautoBatchPost'
import { generateFeatureMaterial } from './lovemiFeatureMaterial'
import {
  deleteFeatureMaterial,
  listFeatureMaterials,
  upsertFeatureMaterial,
} from './featureMaterialDb'
import {
  loadCreateCharReferenceImage,
  loadCreateCharUiState,
  loadRecoverableCreateCharRuns,
  markActiveCreateCharRunsInterrupted,
  saveCreateCharRun,
  saveCreateCharUiState,
  type CreateCharRunSnapshot,
} from './createCharStateDb'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged

// 固定库存目录，避免 setName / productName 把 userData 拆成两份（lovemi-auto vs Lovemi Auto）
const APP_DATA = path.join(app.getPath('appData'), 'lovemi-auto')
app.setPath('userData', APP_DATA)
app.setName('Lovemi Auto')
// macOS + Electron 43 在部分机器上会频繁触发 GPU 进程退出（窗口闪退）。
// Windows 有独显时关 GPU 会让 200+ 账号列表明显卡顿，仅在 Darwin 关闭硬件加速。
if (process.platform === 'darwin') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'lovemi-cache',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true,
    },
  },
])

/** 开发态 Electron.app 默认 Dock 名是 Electron；改成产品名，避免和第二个实例看起来像两个 Electron */
function patchDevDockName() {
  if (!isDev || process.platform !== 'darwin') return
  try {
    const plist = path.join(process.execPath, '..', '..', 'Info.plist')
    if (!fs.existsSync(plist)) return
    let raw = fs.readFileSync(plist, 'utf8')
    if (!raw.includes('<string>Electron</string>') && !raw.includes('<string>Electron Helper')) return
    const next = raw
      .replace(/<key>CFBundleName<\/key>\s*<string>Electron<\/string>/, '<key>CFBundleName</key>\n\t<string>Lovemi Auto</string>')
      .replace(
        /<key>CFBundleDisplayName<\/key>\s*<string>Electron<\/string>/,
        '<key>CFBundleDisplayName</key>\n\t<string>Lovemi Auto</string>',
      )
    if (next !== raw) fs.writeFileSync(plist, next, 'utf8')
  } catch {
    /* 无写权限时忽略 */
  }
}

let mainWindow: BrowserWindow | null = null
let recoveringRenderer = false

function recoverMainWindow(crashedWindow: BrowserWindow, reason: string) {
  // 旧窗口 destroy 后还可能迟到多个 render-process-gone 事件。
  // 绝不能让旧事件误杀刚创建的新窗口，否则会形成 2~6 秒一次的闪退循环。
  if (crashedWindow !== mainWindow || crashedWindow.isDestroyed()) return
  if (recoveringRenderer) return
  recoveringRenderer = true
  appendConsoleLog({
    level: 'warn',
    action: 'create_char',
    message: `窗口渲染进程异常，自动恢复 · ${reason}`.slice(0, 220),
  })
  try {
    if (!crashedWindow.isDestroyed()) crashedWindow.destroy()
  } catch {
    /* ignore */
  }
  mainWindow = null
  setTimeout(() => {
    try {
      createWindow()
    } finally {
      recoveringRenderer = false
    }
  }, 350)
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b0b0d',
    title: 'Lovemi Auto',
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 16, y: 16 },
        }
      : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: '#0b0b0d',
            symbolColor: '#f5a3c7',
            height: 40,
          },
        }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow = window

  if (isDev) {
    window.loadURL(process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173')
  } else {
    window.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    recoverMainWindow(window, `render-process-gone:${details.reason}`)
  })
  window.webContents.on('unresponsive', () => {
    appendConsoleLog({
      level: 'warn',
      action: 'ui',
      message: '窗口暂时无响应（主进程正在处理互动队列，已保留窗口不强制重启）',
    })
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // 第二个实例直接退出 → Dock 不会再多一个 Electron
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) {
      createWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    patchDevDockName()
    mediaCacheDir(APP_DATA)
    protocol.handle('lovemi-cache', async (request) => {
      try {
        const u = new URL(request.url)
        const fileName = decodeURIComponent(u.pathname.replace(/^\/+/, ''))
        if (!fileName || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
          return new Response('bad path', { status: 400 })
        }
        const filePath = path.join(APP_DATA, 'media-cache', fileName)
        if (!fs.existsSync(filePath)) return new Response('not found', { status: 404 })
        const ext = path.extname(fileName).toLowerCase()
        const mime =
          ext === '.mp4'
            ? 'video/mp4'
            : ext === '.webm'
              ? 'video/webm'
              : ext === '.mov'
                ? 'video/quicktime'
                : ext === '.jpg' || ext === '.jpeg'
                  ? 'image/jpeg'
                  : ext === '.png'
                    ? 'image/png'
                    : ext === '.webp'
                      ? 'image/webp'
                      : 'application/octet-stream'
        const stat = await fs.promises.stat(filePath)
        const range = request.headers.get('range')
        if (range && /^video\//.test(mime)) {
          const match = range.match(/bytes=(\d*)-(\d*)/)
          if (match) {
            const start = match[1] ? Number(match[1]) : 0
            const requestedEnd = match[2] ? Number(match[2]) : stat.size - 1
            const end = Math.min(stat.size - 1, Math.max(start, requestedEnd))
            if (start >= stat.size || start < 0) {
              return new Response(null, {
                status: 416,
                headers: { 'Content-Range': `bytes */${stat.size}` },
              })
            }
            const length = end - start + 1
            const data = Buffer.allocUnsafe(length)
            const handle = await fs.promises.open(filePath, 'r')
            try {
              await handle.read(data, 0, length, start)
            } finally {
              await handle.close()
            }
            return new Response(data, {
              status: 206,
              headers: {
                'Content-Type': mime,
                'Content-Length': String(length),
                'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'public, max-age=31536000, immutable',
              },
            })
          }
        }
        const data = await fs.promises.readFile(filePath)
        return new Response(data, {
          status: 200,
          headers: {
            'Content-Type': mime,
            'Content-Length': String(data.length),
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'public, max-age=31536000, immutable',
          },
        })
      } catch (err) {
        return new Response(err instanceof Error ? err.message : 'error', { status: 500 })
      }
    })
    try {
      session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
        if (/assets\.lovemi\.ai|api\.lovemi\.ai/i.test(details.url)) {
          const headers = { ...details.requestHeaders }
          headers.Referer = 'https://app.lovemi.ai/'
          headers.Origin = 'https://app.lovemi.ai'
          callback({ requestHeaders: headers })
          return
        }
        callback({ requestHeaders: details.requestHeaders })
      })
    } catch {
      /* ignore */
    }
    try {
      ensureCopyLibrariesSeeded()
      releaseWorkingActions()
      // 上一整个 App 进程若被杀，保留现场但标记为 interrupted。
      // 渲染进程单独闪退时主进程不退出，运行任务仍会继续。
      markActiveCreateCharRunsInterrupted()
    } catch (err) {
      console.error('[console] seed failed', err)
    }
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  void stopVlessBridge()
  closeAccountsDb()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void stopVlessBridge()
  closeAccountsDb()
})

ipcMain.handle('accounts:load', () => loadAccountsJson())

ipcMain.handle('accounts:save', (_event, plaintext: string) => saveAccountsJson(plaintext))

ipcMain.handle('app:getVersion', () => app.getVersion())

ipcMain.handle('mail:probe', async (_event, input: ProbeInput) => {
  if (!input.proxyUrl) {
    return {
      ok: false,
      email: input.email,
      error: '未配置出站代理（VLESS / 本地兜底），禁止直连',
    }
  }
  return probeAccount({ ...input, fallbackDirect: false })
})

ipcMain.handle('mail:probeBatch', async (_event, inputs: ProbeInput[]) => {
  const patched = inputs.map((input) => ({ ...input, fallbackDirect: false as const }))
  if (patched.some((i) => !i.proxyUrl)) {
    return patched.map((i) => ({
      ok: false,
      email: i.email,
      error: '未配置出站代理（VLESS / 本地兜底），禁止直连',
    }))
  }
  return probeAccountsBatch(patched, 3)
})

ipcMain.handle(
  'proxy:test',
  async (_event, input: { localProxyUrl?: string; urlProxy?: string }) =>
    testProxyConnectivity(input),
)

ipcMain.handle(
  'proxy:resolveMail',
  async (
    _event,
    input: {
      vlessEnabled: boolean
      subscriptionUrl: string
      localEnabled: boolean
      localHost: string
      localPort: number
    },
  ) => {
    const localProxyUrl = `http://${input.localHost || '127.0.0.1'}:${input.localPort || 7897}`
    return resolveMailProxy({
      vlessEnabled: input.vlessEnabled,
      subscriptionUrl: input.subscriptionUrl,
      localEnabled: input.localEnabled,
      localProxyUrl,
    })
  },
)

ipcMain.handle('proxy:vlessStatus', () => getVlessStatus())

ipcMain.handle('lovemi:register', async (_event, input: RegisterInput) => {
  if (!input.proxyUrl) {
    return { ok: false, email: input.email, error: '未配置出站代理（禁止直连）' }
  }
  return registerLovemiAccount(input)
})

ipcMain.handle('lovemi:registerBatch', async (_event, inputs: RegisterInput[]) => {
  const results = []
  for (const input of inputs) {
    if (!input.proxyUrl) {
      results.push({ ok: false, email: input.email, error: '未配置出站代理（禁止直连）' })
      continue
    }
    results.push(await registerLovemiAccount(input))
    await new Promise((r) => setTimeout(r, 4500))
  }
  return results
})

ipcMain.handle('lovemi:login', async (_event, input: LoginInput) => {
  if (!input.proxyUrl) {
    return { ok: false, email: input.email, error: '未配置出站代理（禁止直连）' }
  }
  return loginLovemi(input)
})

ipcMain.handle(
  'lovemi:me',
  async (_event, input: { sessionToken: string; proxyUrl?: string; email?: string }) => {
    if (!input.proxyUrl) return { ok: false, error: '未配置出站代理（禁止直连）' }
    return fetchLovemiMe(input)
  },
)

ipcMain.handle('lovemi:resetPassword', async (_event, input: ResetPasswordInput) => {
  if (!input.proxyUrl) {
    return { ok: false, email: input.email, error: '未配置出站代理（禁止直连）' }
  }
  return resetLovemiPassword(input)
})

ipcMain.handle('console:ensureSeed', () => ensureCopyLibrariesSeeded())
ipcMain.handle('console:copyStats', () => copyLibraryStats())
ipcMain.handle('console:listComments', (_e, locale?: string) => listCommentTemplates(locale, 1200))
ipcMain.handle('console:listNames', (_e, input?: { locale?: string; onlyFree?: boolean }) =>
  listDisplayNames(input?.locale, Boolean(input?.onlyFree), 1200),
)
ipcMain.handle('console:addComment', (_e, input: { locale: string; body: string }) => {
  if (!isLocale(input.locale) || !input.body?.trim()) return { ok: false, error: '参数无效' }
  return addCommentTemplate(input.locale as LocaleCode, input.body)
})
ipcMain.handle('console:addName', (_e, input: { locale: string; name: string }) => {
  if (!isLocale(input.locale) || !input.name?.trim()) return { ok: false, error: '参数无效' }
  return addDisplayName(input.locale as LocaleCode, input.name)
})
ipcMain.handle('console:logs', (_e, limit?: number) => listConsoleLogs(limit ?? 200))
ipcMain.handle('console:clearLogs', () => {
  clearConsoleLogsView()
  return { ok: true }
})
ipcMain.handle('console:characterStats', () => characterStats())
ipcMain.handle('console:pickLocale', (_e, existing: Array<string | undefined>) =>
  pickBalancedLocale(existing || []),
)
ipcMain.handle(
  'console:renameProfile',
  async (
    _e,
    input: {
      accountId: string
      email: string
      sessionToken: string
      proxyUrl?: string
      locale: string
    },
  ) => {
    if (!input.proxyUrl) return { ok: false, error: '未配置出站代理（禁止直连）' }
    if (!isLocale(input.locale)) return { ok: false, error: '语言无效' }
    return renameAccountProfile({
      accountId: input.accountId,
      email: input.email,
      sessionToken: input.sessionToken,
      proxyUrl: input.proxyUrl,
      locale: input.locale as LocaleCode,
    })
  },
)
ipcMain.handle(
  'console:discover',
  async (
    _e,
    input: {
      sessionToken: string
      proxyUrl?: string
      accountIds: string[]
      pages?: number
      limit?: number
    },
  ) => {
    if (!input.proxyUrl) {
      return {
        ok: false,
        error: '未配置出站代理（禁止直连）',
        pages: 0,
        items: 0,
        inserted: 0,
        pendingCreated: 0,
      }
    }
    return runDiscoveryOnce({
      sessionToken: input.sessionToken,
      proxyUrl: input.proxyUrl,
      accountIds: input.accountIds || [],
      pages: input.pages,
      limit: input.limit,
    })
  },
)
ipcMain.handle(
  'console:engageStep',
  async (
    _e,
    input: {
      accounts: EngageAccount[]
      proxyUrl?: string
      rateMin?: number
      rateMax?: number
    },
  ) => {
    if (!input.proxyUrl) {
      return { ok: false, error: '未配置出站代理（禁止直连）' }
    }
    return runEngageStep({
      accounts: input.accounts || [],
      proxyUrl: input.proxyUrl,
      rateMin: input.rateMin,
      rateMax: input.rateMax,
    })
  },
)
ipcMain.handle(
  'console:log',
  (
    _e,
    input: {
      level: 'info' | 'warn' | 'error'
      action: string
      message: string
      accountEmail?: string
      listingId?: string
    },
  ) => {
    appendConsoleLog(input)
    return { ok: true }
  },
)

ipcMain.handle('createChar:config', () => createCharConfigPublic())
ipcMain.handle('createChar:stateLoad', () => loadCreateCharUiState())
ipcMain.handle('createChar:stateLoadImage', (_e, input: { slot?: number }) =>
  loadCreateCharReferenceImage(Number(input?.slot || 0)),
)
ipcMain.handle(
  'createChar:stateSave',
  (
    _e,
    input: {
      state?: Record<string, unknown>
      imageUpdates?: Array<{ slot: number; mimeType: string; imageBase64: string | null }>
    },
  ) =>
    saveCreateCharUiState({
      state: input?.state || {},
      imageUpdates: input?.imageUpdates,
    }),
)

ipcMain.handle(
  'createChar:saveConfig',
  (
    _e,
    input: {
      teamoApiBase?: string
      teamoApiKey?: string
      teamoModel?: string
      adminSessionToken?: string
      adminEmailLocal?: string
      adminAccountId?: string
      downloadsDir?: string
      autoDownloadWatermark?: boolean
      featureAspectRatio?: string
      featureImageMp?: number
    },
  ) => {
    const patch = { ...(input || {}) } as Partial<CreateCharSecrets>
    if (typeof patch.adminSessionToken === 'string') {
      // 允许粘贴 "Bearer xxx"
      patch.adminSessionToken = patch.adminSessionToken.replace(/^Bearer\s+/i, '').trim()
    }
    if (typeof patch.teamoApiKey === 'string') {
      patch.teamoApiKey = patch.teamoApiKey.trim()
    }
    if (typeof patch.downloadsDir === 'string') {
      patch.downloadsDir = patch.downloadsDir.trim()
    }
    if (typeof patch.autoDownloadWatermark === 'boolean') {
      patch.autoDownloadWatermark = patch.autoDownloadWatermark
    }
    saveCreateCharSecrets(patch)
    return createCharConfigPublic()
  },
)

ipcMain.handle('createChar:pickDownloadsDir', async () => {
  const secrets = loadCreateCharSecrets()
  const fallback = app.getPath('downloads')
  const current = (secrets.downloadsDir || '').trim() || fallback
  const opts: Electron.OpenDialogOptions = {
    title: '选择推特资源保存位置',
    message: '将在所选文件夹下创建「推特资源」子目录存放立绘/视频',
    defaultPath: current,
    properties: ['openDirectory', 'createDirectory'],
  }
  const res = mainWindow
    ? await dialog.showOpenDialog(mainWindow, opts)
    : await dialog.showOpenDialog(opts)
  if (res.canceled || !res.filePaths[0]) {
    return { ok: false as const, ...createCharConfigPublic(), defaultDownloadsDir: fallback }
  }
  saveCreateCharSecrets({ downloadsDir: res.filePaths[0] })
  return { ok: true as const, ...createCharConfigPublic(), defaultDownloadsDir: fallback }
})

function resolveTwitterDownloadsParent() {
  const custom = (loadCreateCharSecrets().downloadsDir || '').trim()
  if (custom && fs.existsSync(custom)) return custom
  return app.getPath('downloads')
}

ipcMain.handle(
  'createChar:analyze',
  async (
    _e,
    input: {
      imageBase64: string
      mimeType?: string
      proxyUrl?: string
      userHint?: string
    },
  ) => {
    if (!input.proxyUrl) return { ok: false, error: '未配置出站代理（禁止直连）' }
    // 中转站只识图 → JSON + 立绘提示词；真正生图走 Lovemi job
    return analyzeReferenceImage({
      imageBase64: input.imageBase64,
      mimeType: input.mimeType,
      proxyUrl: input.proxyUrl,
      userHint: input.userHint,
    })
  },
)

ipcMain.handle(
  'caption:generate',
  async (
    _e,
    input: {
      proxyUrl?: string
      images?: Array<{ base64: string; mimeType?: string }>
      fileName?: string
      characterName?: string
      userHint?: string
      style?: 'standard' | 'twitterComment'
    },
  ) => {
    if (!input.proxyUrl) return { ok: false, error: '未配置出站代理（禁止直连）' }
    return generateSocialCaption({
      proxyUrl: input.proxyUrl,
      images: input.images || [],
      fileName: input.fileName,
      characterName: input.characterName,
      userHint: input.userHint,
      style: input.style,
    })
  },
)

ipcMain.handle('caption:tgautoSettingsGet', () => loadTgautoBridgeSettings(APP_DATA))
ipcMain.handle(
  'caption:tgautoSettingsSave',
  (
    _e,
    patch: {
      baseUrl?: string
      peer?: string
      accountIds?: number[]
      skipPosted?: boolean
    },
  ) => saveTgautoBridgeSettings(APP_DATA, patch || {}),
)
ipcMain.handle('caption:tgautoHealth', async (_e, input?: { baseUrl?: string }) => {
  const settings = loadTgautoBridgeSettings(APP_DATA)
  return checkTgautoHealth(input?.baseUrl || settings.baseUrl)
})
ipcMain.handle('caption:tgautoPreview', () =>
  previewTgautoBatch(APP_DATA, resolveTwitterDownloadsParent()),
)
ipcMain.handle('caption:tgautoBatchCancel', () => {
  cancelTgautoBatch()
  return { ok: true as const, running: isTgautoBatchRunning() }
})
ipcMain.handle('caption:tgautoBatchRunning', () => ({ running: isTgautoBatchRunning() }))
ipcMain.handle(
  'caption:tgautoBatchStart',
  async (
    event,
    input: {
      proxyUrl?: string
      baseUrl?: string
      peer?: string
      accountIds?: number[]
      skipPosted?: boolean
    },
  ) => {
    if (!input?.proxyUrl) return { ok: false, error: '未配置出站代理（禁止直连）', posted: 0, failed: 0, skipped: 0, total: 0 }
    const sender = event.sender
    const onProgress = (p: TgautoBatchProgress) => {
      try {
        if (!sender.isDestroyed()) sender.send('caption:tgautoBatchProgress', p)
      } catch {
        /* ignore */
      }
    }
    return runTgautoBatchPost({
      appData: APP_DATA,
      downloadsParent: resolveTwitterDownloadsParent(),
      proxyUrl: input.proxyUrl,
      baseUrl: input.baseUrl,
      peer: input.peer,
      accountIds: input.accountIds,
      skipPosted: input.skipPosted,
      onProgress,
    })
  },
)

type FeatureMaterialQueueInput = {
  runId: string
  userPrompt: string
  proxyUrl?: string
  sessionToken?: string
  aspectRatio?: string
  imageMp?: number
}

type FeatureMaterialQueueItem = {
  input: FeatureMaterialQueueInput
  resolve: (value: Record<string, unknown>) => void
}

const featureMaterialQueue: FeatureMaterialQueueItem[] = []
const cancelledFeatureMaterialRuns = new Set<string>()
let featureMaterialQueueRunning = false
let activeFeatureMaterialRunId = ''

function broadcastFeatureMaterialProgress(progress: Record<string, unknown>) {
  const target = mainWindow
  if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return
  target.webContents.send('featureMaterial:progress', progress)
}

function refreshFeatureMaterialQueuePositions() {
  featureMaterialQueue.forEach((item, index) => {
    broadcastFeatureMaterialProgress({
      runId: item.input.runId,
      stage: 'queued',
      queuePosition: index + 1,
    })
  })
}

async function drainFeatureMaterialQueue() {
  if (featureMaterialQueueRunning) return
  featureMaterialQueueRunning = true
  try {
    while (featureMaterialQueue.length) {
      const item = featureMaterialQueue.shift()!
      refreshFeatureMaterialQueuePositions()
      const { input } = item
      if (cancelledFeatureMaterialRuns.delete(input.runId)) {
        broadcastFeatureMaterialProgress({ runId: input.runId, stage: 'cancelled' })
        item.resolve({ ok: false, cancelled: true, runId: input.runId, error: '排队任务已取消' })
        continue
      }
      if (!input.proxyUrl) {
        item.resolve({ ok: false, runId: input.runId, error: '未配置出站代理（禁止直连）' })
        continue
      }
      const secrets = loadCreateCharSecrets()
      const token = secrets.adminSessionToken || input.sessionToken || ''
      if (!token) {
        item.resolve({ ok: false, runId: input.runId, error: '请配置管理员 Bearer' })
        continue
      }
      activeFeatureMaterialRunId = input.runId
      const runStartedAt = Date.now()
      broadcastFeatureMaterialProgress({
        runId: input.runId,
        stage: 'running',
        queuePosition: 0,
        runStartedAt,
      })
      try {
        const secretsAspect = secrets.featureAspectRatio
        const secretsMp = secrets.featureImageMp
        const result = await generateFeatureMaterial({
          userPrompt: input.userPrompt,
          proxyUrl: input.proxyUrl,
          sessionToken: token,
          aspectRatio: (input.aspectRatio || secretsAspect) as never,
          imageMp: (input.imageMp ?? secretsMp) as never,
          isCancelled: () => cancelledFeatureMaterialRuns.has(input.runId),
          onProgress: (progress) =>
            broadcastFeatureMaterialProgress({
              ...progress,
              runId: input.runId,
              runStartedAt,
            }),
        })
        let cached: Record<string, unknown> = {}
        if (result.ok && result.cdnUrl) {
          const applyWatermark = secrets.autoDownloadWatermark !== false
          cached = await cacheLovemiCdnMedia({
            cdnUrl: result.cdnUrl,
            proxyUrl: input.proxyUrl,
            appData: APP_DATA,
            saveDisplayName: result.title || '特色素材',
            downloadsPath: resolveTwitterDownloadsParent(),
            applyWatermark,
            kind: 'media',
            assetId: result.assetId,
            runId: input.runId,
          })
        }
        const response: Record<string, unknown> = {
          ...result,
          ...cached,
          runId: input.runId,
          runStartedAt,
          cancelled: cancelledFeatureMaterialRuns.has(input.runId),
        }
        const stage = result.ok ? 'completed' : response.cancelled ? 'cancelled' : 'failed'
        upsertFeatureMaterial({
          runId: input.runId,
          userPrompt: input.userPrompt,
          title: typeof response.title === 'string' ? response.title : undefined,
          prompt: typeof response.prompt === 'string' ? response.prompt : undefined,
          detail: typeof response.detail === 'string' ? response.detail : undefined,
          jobId: typeof response.jobId === 'string' ? response.jobId : undefined,
          assetId: typeof response.assetId === 'string' ? response.assetId : undefined,
          cdnUrl: typeof response.cdnUrl === 'string' ? response.cdnUrl : undefined,
          cacheUrl: typeof response.cacheUrl === 'string' ? response.cacheUrl : undefined,
          localPath: typeof response.localPath === 'string' ? response.localPath : undefined,
          twitterPath: typeof response.twitterPath === 'string' ? response.twitterPath : undefined,
          watermarkApplied:
            typeof response.watermarkApplied === 'boolean' ? response.watermarkApplied : undefined,
          stage,
          error: typeof response.error === 'string' ? response.error : undefined,
          createdAt: runStartedAt,
          updatedAt: Date.now(),
        })
        broadcastFeatureMaterialProgress({
          ...response,
          stage,
        })
        item.resolve(response)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        broadcastFeatureMaterialProgress({ runId: input.runId, stage: 'failed', error: message })
        item.resolve({ ok: false, runId: input.runId, error: message })
      } finally {
        cancelledFeatureMaterialRuns.delete(input.runId)
        if (activeFeatureMaterialRunId === input.runId) activeFeatureMaterialRunId = ''
      }
    }
  } finally {
    featureMaterialQueueRunning = false
  }
}

ipcMain.handle('featureMaterial:enqueue', async (_event, input: FeatureMaterialQueueInput) => {
  if (!input.runId) return { ok: false, error: '缺少 runId' }
  if (!input.userPrompt?.trim()) return { ok: false, error: '请输入自定义提示词' }
  return new Promise<Record<string, unknown>>((resolve) => {
    const item: FeatureMaterialQueueItem = {
      input: { ...input, userPrompt: input.userPrompt.trim() },
      resolve,
    }
    featureMaterialQueue.push(item)
    broadcastFeatureMaterialProgress({
      runId: input.runId,
      stage: 'queued',
      queuePosition: featureMaterialQueue.length,
    })
    refreshFeatureMaterialQueuePositions()
    void drainFeatureMaterialQueue()
  })
})

ipcMain.handle('featureMaterial:cancel', async (_event, input: { runId?: string }) => {
  const runId = input.runId?.trim()
  if (!runId) return { ok: false, error: '缺少 runId' }
  cancelledFeatureMaterialRuns.add(runId)
  for (let index = featureMaterialQueue.length - 1; index >= 0; index--) {
    const item = featureMaterialQueue[index]
    if (item.input.runId !== runId) continue
    featureMaterialQueue.splice(index, 1)
    broadcastFeatureMaterialProgress({ runId, stage: 'cancelled' })
    item.resolve({ ok: false, cancelled: true, runId, error: '排队任务已取消' })
    cancelledFeatureMaterialRuns.delete(runId)
  }
  refreshFeatureMaterialQueuePositions()
  return { ok: true, running: activeFeatureMaterialRunId === runId }
})

ipcMain.handle('featureMaterial:list', async () => {
  return { ok: true, items: listFeatureMaterials(80) }
})

ipcMain.handle('featureMaterial:delete', async (_event, input: { runId?: string }) => {
  const runId = input?.runId?.trim()
  if (!runId) return { ok: false, error: '缺少 runId' }
  return deleteFeatureMaterial({ runId, appData: APP_DATA })
})

ipcMain.handle(
  'createChar:waitPortrait',
  async (
    _e,
    input: {
      characterId: string
      sessionToken?: string
      proxyUrl?: string
      jobId?: string
      forceRestart?: boolean
    },
  ) => {
    if (!input.proxyUrl) return { ok: false, error: '未配置出站代理（禁止直连）' }
    if (!input.characterId) return { ok: false, error: '缺少 characterId' }
    const secrets = loadCreateCharSecrets()
    const token = secrets.adminSessionToken || input.sessionToken || ''
    if (!token) return { ok: false, error: '请配置管理员 Bearer 或选择有 Token 的账号' }
    return waitLovemiPortrait({
      characterId: input.characterId,
      sessionToken: token,
      proxyUrl: input.proxyUrl,
      jobId: input.jobId,
      forceRestart: input.forceRestart === true,
    })
  },
)

ipcMain.handle(
  'createChar:refreshPortrait',
  async (
    _e,
    input: {
      characterId: string
      sessionToken?: string
      proxyUrl?: string
    },
  ) => {
    if (!input.proxyUrl) return { ok: false, error: '未配置出站代理（禁止直连）' }
    if (!input.characterId) return { ok: false, error: '缺少 characterId' }
    const secrets = loadCreateCharSecrets()
    const token = secrets.adminSessionToken || input.sessionToken || ''
    if (!token) return { ok: false, error: '请配置管理员 Bearer 或选择有 Token 的账号' }
    return fetchCharacterPortraitPreview({
      characterId: input.characterId,
      sessionToken: token,
      proxyUrl: input.proxyUrl,
    })
  },
)

ipcMain.handle(
  'createChar:create',
  async (
    _e,
    input: {
      sessionToken?: string
      proxyUrl?: string
      body: Record<string, unknown>
      waitPortrait?: boolean
    },
  ) => {
    if (!input.proxyUrl) return { ok: false, error: '未配置出站代理（禁止直连）' }
    const secrets = loadCreateCharSecrets()
    // 本机管理员 Bearer（Lumi Vale 浏览器 Token）优先；下拉库存号仅备用
    const token = secrets.adminSessionToken || input.sessionToken || ''
    if (!token) return { ok: false, error: '请配置管理员 Bearer（创建角色页保存）或选择有 Token 的账号' }
    const result = await createLovemiCharacter({
      sessionToken: token,
      proxyUrl: input.proxyUrl,
      body: input.body || {},
      waitPortrait: input.waitPortrait !== false,
    })
    if (result.ok) {
      const who = secrets.adminEmailLocal ? ` · 归属 ${secrets.adminEmailLocal}` : ' · 归属本机管理员 Bearer'
      appendConsoleLog({
        level: 'info',
        action: 'create_char',
        message: `已创建角色「${String(input.body?.display_name || '')}」${who}${result.portrait?.cdnUrl ? ' · Lovemi 立绘已出' : ''}`,
      })
    }
    return {
      ...result,
      createdAs: secrets.adminEmailLocal || 'admin-bearer',
    }
  },
)

ipcMain.handle(
  'createChar:motionVideo',
  async (
    _e,
    input: {
      characterId: string
      sessionToken?: string
      proxyUrl?: string
      prompt?: string
      inputAssetId?: string
      /** direct = 旧图生视频（常出 orphan asset）；companion = 对话逼视频（进角色资产，默认） */
      mode?: 'companion' | 'direct'
    },
  ) => {
    if (!input.proxyUrl) return { ok: false, error: '未配置出站代理（禁止直连）' }
    if (!input.characterId) return { ok: false, error: '缺少 characterId' }
    const secrets = loadCreateCharSecrets()
    const token = secrets.adminSessionToken || input.sessionToken || ''
    if (!token) return { ok: false, error: '请配置管理员 Bearer' }

    if (input.mode === 'direct') {
      return generateMotionVideo({
        characterId: input.characterId,
        sessionToken: token,
        proxyUrl: input.proxyUrl,
        prompt: input.prompt,
        inputAssetId: input.inputAssetId,
      })
    }

    // 默认：companion messages → 角色绑定视频（可挂 presentation）
    const res = await requestCompanionMotionVideo({
      characterId: input.characterId,
      sessionToken: token,
      proxyUrl: input.proxyUrl,
      prompt: input.prompt,
    })
    if (!res.ok) {
      return { ok: false, error: res.error, jobId: res.jobIds?.[0], labProjectId: res.labProjectId }
    }
    return {
      ok: true,
      outputAssetId: res.videoAssetId,
      jobId: res.jobIds?.[res.jobIds.length - 1],
      labProjectId: res.labProjectId,
      note: 'companion 对话视频已写入角色资产，可用于 presentation.motion_asset_id',
    }
  },
)

ipcMain.handle(
  'createChar:setPreviewPublish',
  async (
    _e,
    input: {
      characterId: string
      sessionToken?: string
      proxyUrl?: string
      coverAssetId: string
      videoAssetId?: string
      title?: string
      description?: string
      publish?: boolean
      listingId?: string
    },
  ) => {
    if (!input.proxyUrl) return { ok: false, error: '未配置出站代理（禁止直连）' }
    if (!input.characterId) return { ok: false, error: '缺少 characterId' }
    if (!input.coverAssetId) return { ok: false, error: '缺少封面 coverAssetId（立绘 asset）' }
    const secrets = loadCreateCharSecrets()
    const token = secrets.adminSessionToken || input.sessionToken || ''
    if (!token) return { ok: false, error: '请配置管理员 Bearer' }
    return setPreviewAndMaybePublish({
      characterId: input.characterId,
      sessionToken: token,
      proxyUrl: input.proxyUrl,
      coverAssetId: input.coverAssetId,
      videoAssetId: input.videoAssetId,
      title: input.title,
      description: input.description,
      publish: input.publish,
      listingId: input.listingId,
    })
  },
)

ipcMain.handle(
  'createChar:generateMotionOnly',
  async (
    _e,
    input: {
      characterId: string
      sessionToken?: string
      proxyUrl?: string
      portraitCdnUrl?: string
      imageBase64?: string
      mimeType?: string
      coverAssetId?: string
      characterHint?: string
      appearanceHint?: string
    },
  ) => {
    if (!input.proxyUrl) return { ok: false, error: '未配置出站代理（禁止直连）' }
    if (!input.characterId) return { ok: false, error: '缺少 characterId' }
    const secrets = loadCreateCharSecrets()
    const token = secrets.adminSessionToken || input.sessionToken || ''
    if (!token) return { ok: false, error: '请配置管理员 Bearer' }
    return generateMotionVideoOnly({
      characterId: input.characterId,
      sessionToken: token,
      proxyUrl: input.proxyUrl,
      portraitCdnUrl: input.portraitCdnUrl,
      imageBase64: input.imageBase64,
      mimeType: input.mimeType,
      coverAssetId: input.coverAssetId,
      characterHint: input.characterHint,
      appearanceHint: input.appearanceHint,
    })
  },
)

ipcMain.handle(
  'createChar:autoVideoPublish',
  async (
    _e,
    input: {
      characterId: string
      sessionToken?: string
      proxyUrl?: string
      portraitCdnUrl?: string
      imageBase64?: string
      mimeType?: string
      coverAssetId?: string
      characterHint?: string
      appearanceHint?: string
      payload?: Record<string, unknown>
      motionPromptOverride?: string
    },
  ) => {
    if (!input.proxyUrl) return { ok: false, error: '未配置出站代理（禁止直连）' }
    if (!input.characterId) return { ok: false, error: '缺少 characterId' }
    const secrets = loadCreateCharSecrets()
    const token = secrets.adminSessionToken || input.sessionToken || ''
    if (!token) return { ok: false, error: '请配置管理员 Bearer' }
    return autoVideoAndPublish({
      characterId: input.characterId,
      sessionToken: token,
      proxyUrl: input.proxyUrl,
      portraitCdnUrl: input.portraitCdnUrl,
      imageBase64: input.imageBase64,
      mimeType: input.mimeType,
      coverAssetId: input.coverAssetId,
      characterHint: input.characterHint,
      appearanceHint: input.appearanceHint,
      payload: input.payload,
      motionPromptOverride: input.motionPromptOverride,
    })
  },
)

type CreateCharJobKind = 'create' | 'motion' | 'autoPublish' | 'pullPublish' | 'fullAuto'

type CreateCharQueueInput = {
  jobKind: CreateCharJobKind
  imageBase64?: string
  imagePath?: string
  mimeType?: string
  proxyUrl?: string
  sessionToken?: string
  userHint?: string
  body?: Record<string, unknown>
  waitPortrait?: boolean
  characterId?: string
  portraitCdnUrl?: string
  coverAssetId?: string
  characterHint?: string
  appearanceHint?: string
  payload?: Record<string, unknown>
  motionPromptOverride?: string
  title?: string
  description?: string
  clientSlot?: 1 | 2 | 3 | 4 | 5
  clientRunEpoch?: number
  clientRunId: string
}

type CreateCharQueueItem = {
  input: CreateCharQueueInput
  sender: WebContents
  resolve: (value: Record<string, unknown>) => void
}

const fullAutoQueue: CreateCharQueueItem[] = []
const cancelledFullAutoRuns = new Set<string>()
const fullAutoRuntime = new Map<string, CreateCharRunSnapshot>()
let fullAutoQueueRunning = false
let activeFullAutoRunId = ''

function stagedFullAutoImagePath(runId: string) {
  const safeId = createHash('sha1').update(runId).digest('hex')
  const dir = path.join(APP_DATA, 'create-char-queue')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${safeId}.image`)
}

function cleanupStagedFullAutoImage(input: CreateCharQueueInput) {
  if (!input.imagePath) return
  try {
    fs.unlinkSync(input.imagePath)
  } catch {
    /* already removed */
  }
}

function broadcastCreateCharProgress(progress: Record<string, unknown>) {
  const target = mainWindow
  if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return
  target.webContents.send('createChar:progress', progress)
}

function persistFullAutoProgress(
  item: CreateCharQueueItem,
  progress: Record<string, unknown>,
  status?: CreateCharRunSnapshot['status'],
) {
  const runId = item.input.clientRunId
  const previous = fullAutoRuntime.get(runId)
  const stage = String(progress.stage || previous?.stage || 'queued')
  const nextStatus: CreateCharRunSnapshot['status'] =
    status ||
    (stage === 'queued'
      ? 'queued'
      : stage === 'cancelled'
        ? 'cancelled'
        : stage === 'failed' || stage === 'video_failed'
          ? 'failed'
          : stage === 'published'
            ? 'completed'
            : 'running')
  const snapshot: CreateCharRunSnapshot = {
    ...(previous || {}),
    ...progress,
    runId,
    slot: Number(item.input.clientSlot || previous?.slot || 1),
    epoch: Number(item.input.clientRunEpoch || previous?.epoch || 0),
    status: nextStatus,
    stage,
    clientSlot: item.input.clientSlot,
    clientRunEpoch: item.input.clientRunEpoch,
    jobKind: item.input.jobKind,
  }
  fullAutoRuntime.set(runId, snapshot)
  try {
    saveCreateCharRun(snapshot)
  } catch (error) {
    appendConsoleLog({
      level: 'warn',
      action: 'create_char',
      message: `队列现场写入 SQLite 失败 · ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        220,
      ),
    })
  }
  broadcastCreateCharProgress(snapshot)
}

function sendFullAutoQueueProgress(
  item: CreateCharQueueItem,
  stage: 'queued' | 'running' | 'cancelled' | 'failed',
  queuePosition = 0,
  runStartedAt?: number,
  error?: string,
) {
  persistFullAutoProgress(item, {
    stage,
    queuePosition,
    runStartedAt,
    error,
  })
}

ipcMain.handle('createChar:runtimeState', () => {
  const live = [...fullAutoRuntime.values()]
  const persisted = loadRecoverableCreateCharRuns()
  const byRun = new Map<string, CreateCharRunSnapshot>()
  for (const snapshot of persisted) byRun.set(snapshot.runId, snapshot)
  for (const snapshot of live) byRun.set(snapshot.runId, snapshot)
  return { ok: true, runs: [...byRun.values()] }
})

function refreshFullAutoQueuePositions() {
  fullAutoQueue.forEach((item, index) => sendFullAutoQueueProgress(item, 'queued', index + 1))
}

async function executeCreateCharQueueItem(
  item: CreateCharQueueItem,
  token: string,
  runStartedAt: number,
): Promise<Record<string, unknown>> {
  const { input } = item
  const proxyUrl = input.proxyUrl!
  const imageBase64 =
    input.imagePath && fs.existsSync(input.imagePath)
      ? fs.readFileSync(input.imagePath).toString('base64')
      : undefined
  const isCancelled = () => cancelledFullAutoRuns.has(input.clientRunId)

  if (input.jobKind === 'create') {
    const result = await createLovemiCharacter({
      sessionToken: token,
      proxyUrl,
      body: input.body || {},
      waitPortrait: input.waitPortrait !== false,
    })
    if (result.ok) {
      const secrets = loadCreateCharSecrets()
      const who = secrets.adminEmailLocal ? ` · 归属 ${secrets.adminEmailLocal}` : ' · 归属本机管理员 Bearer'
      appendConsoleLog({
        level: 'info',
        action: 'create_char',
        message: `已创建角色「${String(input.body?.display_name || '')}」${who}${result.portrait?.cdnUrl ? ' · Lovemi 立绘已出' : ''}`,
      })
      return { ...result, createdAs: secrets.adminEmailLocal || 'admin-bearer' }
    }
    return result
  }

  if (!input.characterId && input.jobKind !== 'fullAuto') {
    return { ok: false, error: '缺少 characterId' }
  }

  if (input.jobKind === 'motion') {
    return generateMotionVideoOnly({
      characterId: input.characterId!,
      sessionToken: token,
      proxyUrl,
      portraitCdnUrl: input.portraitCdnUrl,
      imageBase64,
      mimeType: input.mimeType,
      coverAssetId: input.coverAssetId,
      characterHint: input.characterHint,
      appearanceHint: input.appearanceHint,
    })
  }

  if (input.jobKind === 'autoPublish') {
    return autoVideoAndPublish({
      characterId: input.characterId!,
      sessionToken: token,
      proxyUrl,
      portraitCdnUrl: input.portraitCdnUrl,
      imageBase64,
      mimeType: input.mimeType,
      coverAssetId: input.coverAssetId,
      characterHint: input.characterHint,
      appearanceHint: input.appearanceHint,
      payload: input.payload,
      motionPromptOverride: input.motionPromptOverride,
      isCancelled,
    })
  }

  if (input.jobKind === 'pullPublish') {
    const pulled = await fetchLatestCharacterVideo({
      characterId: input.characterId!,
      sessionToken: token,
      proxyUrl,
    })
    if (!pulled.ok || !pulled.videoAssetId) {
      return { ...pulled, ok: false, error: pulled.error || '站内暂无视频' }
    }
    let coverAssetId = input.coverAssetId || ''
    if (!coverAssetId) {
      const portrait = await fetchCharacterPortraitPreview({
        characterId: input.characterId!,
        sessionToken: token,
        proxyUrl,
      })
      coverAssetId = portrait.assetId || ''
    }
    if (!coverAssetId) {
      return {
        ok: false,
        error: '有视频但缺少立绘 asset，无法绑封面发布',
        videoAssetId: pulled.videoAssetId,
        cdnUrl: pulled.cdnUrl,
      }
    }
    const published = await setPreviewAndMaybePublish({
      characterId: input.characterId!,
      sessionToken: token,
      proxyUrl,
      coverAssetId,
      videoAssetId: pulled.videoAssetId,
      title: input.title,
      description: input.description,
      publish: true,
    })
    return {
      ...published,
      coverAssetId,
      videoAssetId: pulled.videoAssetId,
      cdnUrl: pulled.cdnUrl,
    }
  }

  if (!imageBase64) return { ok: false, error: '请先粘贴参考图' }
  return fullAutoToPublish({
    imageBase64,
    mimeType: input.mimeType,
    proxyUrl,
    sessionToken: token,
    userHint: input.userHint,
    runId: input.clientRunId,
    runStartedAt,
    isCancelled,
    onProgress: (progress) => {
      persistFullAutoProgress(item, { ...progress, runStartedAt })
    },
  })
}

async function drainFullAutoQueue() {
  if (fullAutoQueueRunning) return
  fullAutoQueueRunning = true
  try {
    while (fullAutoQueue.length) {
      const item = fullAutoQueue.shift()!
      refreshFullAutoQueuePositions()
      const { input } = item
      if (cancelledFullAutoRuns.delete(input.clientRunId)) {
        sendFullAutoQueueProgress(item, 'cancelled')
        item.resolve({ ok: false, cancelled: true, runId: input.clientRunId, error: '排队任务已取消' })
        cleanupStagedFullAutoImage(input)
        continue
      }
      if (!input.proxyUrl) {
        sendFullAutoQueueProgress(item, 'failed', 0, undefined, '未配置出站代理（禁止直连）')
        item.resolve({ ok: false, runId: input.clientRunId, error: '未配置出站代理（禁止直连）' })
        cleanupStagedFullAutoImage(input)
        continue
      }
      if (input.jobKind === 'fullAuto' && (!input.imagePath || !fs.existsSync(input.imagePath))) {
        sendFullAutoQueueProgress(item, 'failed', 0, undefined, '请先粘贴参考图')
        item.resolve({ ok: false, runId: input.clientRunId, error: '请先粘贴参考图' })
        cleanupStagedFullAutoImage(input)
        continue
      }
      const secrets = loadCreateCharSecrets()
      const token = secrets.adminSessionToken || input.sessionToken || ''
      if (!token) {
        sendFullAutoQueueProgress(item, 'failed', 0, undefined, '请配置管理员 Bearer')
        item.resolve({ ok: false, runId: input.clientRunId, error: '请配置管理员 Bearer' })
        cleanupStagedFullAutoImage(input)
        continue
      }
      const runStartedAt = Date.now()
      activeFullAutoRunId = input.clientRunId
      sendFullAutoQueueProgress(item, 'running', 0, runStartedAt)
      try {
        const result = await executeCreateCharQueueItem(item, token, runStartedAt)
        if (!result.ok && !(result as { cancelled?: boolean }).cancelled) {
          sendFullAutoQueueProgress(
            item,
            'failed',
            0,
            runStartedAt,
            typeof result.error === 'string' ? result.error : '队列任务失败',
          )
        }
        persistFullAutoProgress(
          item,
          {
            ...result,
            stage: result.ok ? 'completed' : (result as { cancelled?: boolean }).cancelled ? 'cancelled' : 'failed',
            runStartedAt,
          },
          result.ok
            ? 'completed'
            : (result as { cancelled?: boolean }).cancelled
              ? 'cancelled'
              : 'failed',
        )
        item.resolve({ ...result, runId: input.clientRunId, runStartedAt })
      } catch (error) {
        persistFullAutoProgress(
          item,
          {
            stage: 'failed',
            runStartedAt,
            error: error instanceof Error ? error.message : String(error),
          },
          'failed',
        )
        item.resolve({
          ok: false,
          runId: input.clientRunId,
          runStartedAt,
          error: error instanceof Error ? error.message : String(error),
        })
      } finally {
        cleanupStagedFullAutoImage(input)
        cancelledFullAutoRuns.delete(input.clientRunId)
        if (activeFullAutoRunId === input.clientRunId) activeFullAutoRunId = ''
      }
    }
  } finally {
    fullAutoQueueRunning = false
  }
}

async function enqueueCreateCharJob(
  sender: WebContents,
  input: CreateCharQueueInput,
): Promise<Record<string, unknown>> {
  if (!input.clientRunId) return { ok: false, error: '缺少队列 runId' }
  let imagePath = ''
  if (input.imageBase64) {
    try {
      imagePath = stagedFullAutoImagePath(input.clientRunId)
      fs.writeFileSync(imagePath, Buffer.from(input.imageBase64, 'base64'))
    } catch (error) {
      return {
        ok: false,
        error: `暂存参考图失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }
  return new Promise<Record<string, unknown>>((resolve) => {
    // 排队数组只保留文件路径，避免 5 槽 base64 在主进程再复制一份。
    const queuedInput: CreateCharQueueInput = {
      ...input,
      imageBase64: undefined,
      imagePath: imagePath || undefined,
    }
    const item: CreateCharQueueItem = { input: queuedInput, sender, resolve }
    fullAutoQueue.push(item)
    sendFullAutoQueueProgress(item, 'queued', fullAutoQueue.length)
    refreshFullAutoQueuePositions()
    void drainFullAutoQueue()
  })
}

ipcMain.handle('createChar:enqueueJob', async (_e, input: CreateCharQueueInput) => {
  return enqueueCreateCharJob(_e.sender, input)
})

ipcMain.handle('createChar:fullAutoPublish', async (_e, input: Omit<CreateCharQueueInput, 'jobKind'>) => {
  return enqueueCreateCharJob(_e.sender, { ...input, jobKind: 'fullAuto' })
})

async function cancelCreateCharJob(input: { runId?: string }) {
  const runId = input.runId?.trim()
  if (!runId) return { ok: false, error: '缺少 runId' }
  cancelledFullAutoRuns.add(runId)
  if (activeFullAutoRunId === runId) {
    appendConsoleLog({
      level: 'warn',
      action: 'create_char',
      message: `已请求取消运行中的全自动任务 · ${runId.slice(0, 8)}`,
    })
  }
  for (let i = fullAutoQueue.length - 1; i >= 0; i--) {
    const item = fullAutoQueue[i]
    if (item.input.clientRunId !== runId) continue
    fullAutoQueue.splice(i, 1)
    cleanupStagedFullAutoImage(item.input)
    sendFullAutoQueueProgress(item, 'cancelled')
    item.resolve({ ok: false, cancelled: true, runId, error: '排队任务已取消' })
    cancelledFullAutoRuns.delete(runId)
  }
  refreshFullAutoQueuePositions()
  return { ok: true }
}

ipcMain.handle('createChar:cancelFullAuto', async (_e, input: { runId?: string }) =>
  cancelCreateCharJob(input),
)

ipcMain.handle('createChar:cancelJob', async (_e, input: { runId?: string }) =>
  cancelCreateCharJob(input),
)

ipcMain.handle(
  'createChar:refreshVideo',
  async (
    _e,
    input: {
      characterId: string
      sessionToken?: string
      proxyUrl?: string
    },
  ) => {
    if (!input.proxyUrl) return { ok: false, error: '未配置出站代理（禁止直连）' }
    if (!input.characterId) return { ok: false, error: '缺少 characterId' }
    const secrets = loadCreateCharSecrets()
    const token = secrets.adminSessionToken || input.sessionToken || ''
    if (!token) return { ok: false, error: '请配置管理员 Bearer 或选择有 Token 的账号' }
    return fetchLatestCharacterVideo({
      characterId: input.characterId,
      sessionToken: token,
      proxyUrl: input.proxyUrl,
    })
  },
)

ipcMain.handle(
  'createChar:cacheMedia',
  async (
    _e,
    input: {
      cdnUrl: string
      proxyUrl?: string
      displayName?: string
      kind?: 'portrait' | 'video' | 'media'
      characterId?: string
      assetId?: string
      runId?: string
    },
  ) => {
    if (!input.proxyUrl) return { ok: false, error: '未配置出站代理（禁止直连）' }
    if (!input.cdnUrl) return { ok: false, error: '缺少 cdnUrl' }
    const applyWatermark = loadCreateCharSecrets().autoDownloadWatermark !== false
    const displayName = input.displayName?.trim() || undefined
    return cacheLovemiCdnMedia({
      cdnUrl: input.cdnUrl,
      proxyUrl: input.proxyUrl,
      appData: APP_DATA,
      saveDisplayName: displayName,
      downloadsPath: displayName ? resolveTwitterDownloadsParent() : undefined,
      applyWatermark,
      kind: input.kind || 'media',
      characterId: input.characterId,
      assetId: input.assetId,
      runId: input.runId,
    })
  },
)
