import { app, BrowserWindow, dialog, ipcMain, protocol, net, session, type WebContents } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged

// 固定库存目录，避免 setName / productName 把 userData 拆成两份（lovemi-auto vs Lovemi Auto）
const APP_DATA = path.join(app.getPath('appData'), 'lovemi-auto')
app.setPath('userData', APP_DATA)
app.setName('Lovemi Auto')
// macOS + Electron 43 在部分机器上会频繁触发 GPU 进程退出（表现为窗口闪退/闪烁重启）。
// 关闭硬件加速可显著提升稳定性，优先保证不闪退。
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

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

function recoverMainWindow(reason: string) {
  if (recoveringRenderer) return
  recoveringRenderer = true
  appendConsoleLog({
    level: 'warn',
    action: 'create_char',
    message: `窗口渲染进程异常，自动恢复 · ${reason}`.slice(0, 220),
  })
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy()
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
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b0b0d',
    title: 'Lovemi Auto',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173')
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    recoverMainWindow(`render-process-gone:${details.reason}`)
  })
  mainWindow.webContents.on('unresponsive', () => {
    recoverMainWindow('unresponsive')
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
        const data = await fs.promises.readFile(filePath)
        return new Response(data, {
          status: 200,
          headers: {
            'Content-Type': mime,
            'Content-Length': String(data.length),
            'Accept-Ranges': 'bytes',
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
    },
  ) => {
    const patch = { ...(input || {}) } as Partial<CreateCharSecrets>
    if (typeof patch.adminSessionToken === 'string') {
      // 允许粘贴 "Bearer xxx"
      patch.adminSessionToken = patch.adminSessionToken.replace(/^Bearer\s+/i, '').trim()
    }
    if (typeof patch.downloadsDir === 'string') {
      patch.downloadsDir = patch.downloadsDir.trim()
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

type FullAutoQueueInput = {
  imageBase64: string
  mimeType?: string
  proxyUrl?: string
  sessionToken?: string
  userHint?: string
  clientSlot?: 1 | 2 | 3 | 4 | 5
  clientRunEpoch?: number
  clientRunId: string
}

type FullAutoQueueItem = {
  input: FullAutoQueueInput
  sender: WebContents
  resolve: (value: Record<string, unknown>) => void
}

const fullAutoQueue: FullAutoQueueItem[] = []
const cancelledFullAutoRuns = new Set<string>()
let fullAutoQueueRunning = false
let activeFullAutoRunId = ''

function sendFullAutoQueueProgress(
  item: FullAutoQueueItem,
  stage: 'queued' | 'running' | 'cancelled' | 'failed',
  queuePosition = 0,
  runStartedAt?: number,
  error?: string,
) {
  if (item.sender.isDestroyed()) return
  item.sender.send('createChar:progress', {
    stage,
    queuePosition,
    runId: item.input.clientRunId,
    runStartedAt,
    clientSlot: item.input.clientSlot,
    clientRunEpoch: item.input.clientRunEpoch,
    error,
  })
}

function refreshFullAutoQueuePositions() {
  fullAutoQueue.forEach((item, index) => sendFullAutoQueueProgress(item, 'queued', index + 1))
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
        continue
      }
      if (!input.proxyUrl) {
        item.resolve({ ok: false, runId: input.clientRunId, error: '未配置出站代理（禁止直连）' })
        continue
      }
      if (!input.imageBase64) {
        item.resolve({ ok: false, runId: input.clientRunId, error: '请先粘贴参考图' })
        continue
      }
      const secrets = loadCreateCharSecrets()
      const token = secrets.adminSessionToken || input.sessionToken || ''
      if (!token) {
        item.resolve({ ok: false, runId: input.clientRunId, error: '请配置管理员 Bearer' })
        continue
      }
      const runStartedAt = Date.now()
      activeFullAutoRunId = input.clientRunId
      sendFullAutoQueueProgress(item, 'running', 0, runStartedAt)
      try {
        const result = await fullAutoToPublish({
          imageBase64: input.imageBase64,
          mimeType: input.mimeType,
          proxyUrl: input.proxyUrl,
          sessionToken: token,
          userHint: input.userHint,
          runId: input.clientRunId,
          runStartedAt,
          isCancelled: () => cancelledFullAutoRuns.has(input.clientRunId),
          onProgress: (p) => {
            if (item.sender.isDestroyed()) return
            item.sender.send('createChar:progress', {
              ...p,
              runId: input.clientRunId,
              runStartedAt,
              clientSlot: input.clientSlot,
              clientRunEpoch: input.clientRunEpoch,
            })
          },
        })
        if (!result.ok && !(result as { cancelled?: boolean }).cancelled) {
          sendFullAutoQueueProgress(
            item,
            'failed',
            0,
            runStartedAt,
            typeof result.error === 'string' ? result.error : '全自动失败',
          )
        }
        item.resolve({ ...result, runId: input.clientRunId, runStartedAt })
      } catch (error) {
        item.resolve({
          ok: false,
          runId: input.clientRunId,
          runStartedAt,
          error: error instanceof Error ? error.message : String(error),
        })
      } finally {
        cancelledFullAutoRuns.delete(input.clientRunId)
        if (activeFullAutoRunId === input.clientRunId) activeFullAutoRunId = ''
      }
    }
  } finally {
    fullAutoQueueRunning = false
  }
}

ipcMain.handle('createChar:fullAutoPublish', async (_e, input: FullAutoQueueInput) => {
  if (!input.clientRunId) return { ok: false, error: '缺少全自动 runId' }
  return new Promise<Record<string, unknown>>((resolve) => {
    const item: FullAutoQueueItem = { input, sender: _e.sender, resolve }
    fullAutoQueue.push(item)
    sendFullAutoQueueProgress(item, 'queued', fullAutoQueue.length)
    refreshFullAutoQueuePositions()
    void drainFullAutoQueue()
  })
})

ipcMain.handle('createChar:cancelFullAuto', async (_e, input: { runId?: string }) => {
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
    sendFullAutoQueueProgress(item, 'cancelled')
    item.resolve({ ok: false, cancelled: true, runId, error: '排队任务已取消' })
    cancelledFullAutoRuns.delete(runId)
  }
  refreshFullAutoQueuePositions()
  return { ok: true }
})

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
    return cacheLovemiCdnMedia({
      cdnUrl: input.cdnUrl,
      proxyUrl: input.proxyUrl,
      appData: APP_DATA,
      saveDisplayName: input.displayName?.trim() || undefined,
      downloadsPath: resolveTwitterDownloadsParent(),
      kind: input.kind || 'media',
      characterId: input.characterId,
      assetId: input.assetId,
      runId: input.runId,
    })
  },
)
