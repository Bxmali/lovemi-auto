import type { ParsedImportLine } from '../types/email'
import { parseProxyBlock } from './parseRealRegisterProxies'

export type { ParsedProxyRow } from './parseRealRegisterProxies'
export { parseProxyBlock, parseProxyLine } from './parseRealRegisterProxies'

export type RealRegisterTask = {
  id: string
  index: number
  region?: string
  skip?: boolean
  skipReason?: string
  proxyUrl?: string
  proxyHost?: string
  email?: string
  emailPassword?: string
  refreshToken?: string
  clientId?: string
  parseError?: string
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped'
  stage?: string
  egressIp?: string
  error?: string
  accountId?: string
}

function shuffle<T>(items: T[]): T[] {
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = arr[i]!
    arr[i] = arr[j]!
    arr[j] = tmp
  }
  return arr
}

/** 仅解析 IP；邮箱从池中随机分配（每条 IP 一个，不重复） */
export function buildRealRegisterTasks(
  proxyRaw: string,
  emailPool: ParsedImportLine[],
): {
  tasks: RealRegisterTask[]
  errors: string[]
} {
  const errors: string[] = []
  const proxies = parseProxyBlock(proxyRaw)
  const hostSeen = new Set<string>()
  const tasks: RealRegisterTask[] = []

  const runnableProxies = proxies.filter((p) => !p.skip && p.proxyUrl && p.proxyHost)
  const shuffledEmails = shuffle(emailPool)

  if (!runnableProxies.length) {
    errors.push('没有可执行的 IP 行')
  }
  if (!emailPool.length) {
    errors.push('邮箱池为空或全部已使用')
  }
  if (runnableProxies.length > shuffledEmails.length) {
    errors.push(`IP ${runnableProxies.length} 条 · 可用邮箱仅 ${shuffledEmails.length} 条`)
  }

  let emailIdx = 0
  let taskIndex = 0

  for (const p of proxies) {
    if (p.skipReason === '地区标题' || p.skipReason === '空行') continue
    taskIndex++
    const id = `rr-${taskIndex}-${Date.now().toString(36)}`

    if (p.skip || !p.proxyUrl || !p.proxyHost) {
      tasks.push({
        id,
        index: taskIndex,
        region: p.region,
        proxyHost: p.proxyHost,
        status: 'skipped',
        skip: true,
        skipReason: p.skipReason || '跳过',
      })
      continue
    }

    if (hostSeen.has(p.proxyHost)) {
      tasks.push({
        id,
        index: taskIndex,
        region: p.region,
        proxyUrl: p.proxyUrl,
        proxyHost: p.proxyHost,
        status: 'skipped',
        skip: true,
        skipReason: 'IP 重复',
      })
      continue
    }
    hostSeen.add(p.proxyHost)

    const email = shuffledEmails[emailIdx]
    if (!email) {
      tasks.push({
        id,
        index: taskIndex,
        region: p.region,
        proxyUrl: p.proxyUrl,
        proxyHost: p.proxyHost,
        status: 'skipped',
        skip: true,
        skipReason: '邮箱池不足',
      })
      continue
    }
    emailIdx++

    tasks.push({
      id,
      index: taskIndex,
      region: p.region,
      proxyUrl: p.proxyUrl,
      proxyHost: p.proxyHost,
      email: email.email,
      emailPassword: email.password,
      refreshToken: email.refreshToken,
      clientId: email.clientId,
      status: 'pending',
    })
  }

  return { tasks, errors }
}
