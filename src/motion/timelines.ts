import gsap from 'gsap'

const pageTls = new WeakMap<HTMLElement, gsap.core.Timeline>()

export function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function isUsableTarget(target: unknown): boolean {
  if (!target) return false
  if (typeof NodeList !== 'undefined' && target instanceof NodeList) return target.length > 0
  return true
}

export function runEnterShell(root: HTMLElement) {
  pageTls.get(root)?.kill()
  if (prefersReducedMotion()) {
    const nodes = root.querySelectorAll('[data-motion]')
    if (nodes.length) gsap.set(nodes, { clearProps: 'all', opacity: 1, y: 0 })
    return
  }
  const sidebar = root.querySelector('[data-motion="sidebar"]')
  const main = root.querySelector('[data-motion="main"]')
  if (!isUsableTarget(sidebar) && !isUsableTarget(main)) return
  const tl = gsap.timeline({ defaults: { ease: 'power3.out' } })
  if (isUsableTarget(sidebar)) {
    tl.fromTo(sidebar, { opacity: 0, x: -16 }, { opacity: 1, x: 0, duration: 0.35 })
  }
  if (isUsableTarget(main)) {
    tl.fromTo(main, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.35 }, '-=0.22')
  }
  pageTls.set(root, tl)
}

/** 只动工具栏，绝不 stagger 上百张卡片（255 张 × 45ms ≈ 11s 布局抖动） */
export function runEmailPageEnter(scope: HTMLElement) {
  pageTls.get(scope)?.kill()
  if (prefersReducedMotion()) return
  const toolbar = scope.querySelector('[data-motion="toolbar"]')
  if (!isUsableTarget(toolbar)) return
  const tl = gsap.timeline({ defaults: { ease: 'power3.out' } })
  tl.fromTo(toolbar, { opacity: 0, y: -8 }, { opacity: 1, y: 0, duration: 0.28 })
  pageTls.set(scope, tl)
}

export function pulseCodeReveal(el: HTMLElement) {
  if (prefersReducedMotion()) return
  const digits = el.querySelectorAll('[data-digit]')
  if (digits.length) {
    gsap.fromTo(
      digits,
      { opacity: 0, y: 10 },
      { opacity: 1, y: 0, stagger: 0.05, duration: 0.28, ease: 'back.out(1.6)' },
    )
  }
  gsap.fromTo(
    el,
    { boxShadow: '0 0 0 rgba(228,90,154,0)' },
    { boxShadow: '0 0 28px rgba(228,90,154,0.35)', duration: 0.35, yoyo: true, repeat: 1 },
  )
}
