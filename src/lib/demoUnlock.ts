export const DEMO_CLICKS = 10
/** 相邻两次点击间隔超过此值则重置计数 */
export const DEMO_CLICK_WINDOW_MS = 6000

export async function verifyDemoPassword(password: string): Promise<boolean> {
  const res = await window.lovemi?.demoVerifyUnlock?.(password)
  return !!res?.ok
}

/** 清除旧版本遗留的本机「已解锁」标记 */
export function clearLegacyDemoUnlockFlag() {
  try {
    localStorage.removeItem('lovemi.demoUnlock.v1')
  } catch {
    /* ignore */
  }
}
