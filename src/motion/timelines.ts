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

const spotlightTls = new WeakMap<HTMLElement, gsap.core.Timeline[]>()

/** 侧栏「可点功能」持续 GSAP 高亮，提醒用户点击 */
export function runNavSpotlight(buttons: HTMLElement[]) {
  for (const el of buttons) {
    spotlightTls.get(el)?.forEach((tl) => tl.kill())
    spotlightTls.delete(el)
  }
  if (prefersReducedMotion() || !buttons.length) return

  gsap.fromTo(
    buttons,
    { opacity: 0.55, x: -10, scale: 0.96 },
    {
      opacity: 1,
      x: 0,
      scale: 1,
      duration: 0.55,
      stagger: 0.12,
      ease: 'back.out(1.7)',
      clearProps: 'opacity,x,scale',
    },
  )

  buttons.forEach((el, index) => {
    const glow = el.querySelector('.nav-spotlight-glow') as HTMLElement | null
    const badge = el.querySelector('.nav-spotlight-badge') as HTMLElement | null
    const tls: gsap.core.Timeline[] = []

    const pulse = gsap.timeline({
      repeat: -1,
      yoyo: true,
      defaults: { ease: 'sine.inOut' },
      delay: index * 0.18,
    })
    pulse
      .to(el, {
        boxShadow: '0 0 0 1px rgba(255,170,210,0.55), 0 0 22px rgba(228,90,154,0.45)',
        borderColor: 'rgba(255,170,210,0.65)',
        duration: 1.15,
      })
      .to(el, {
        boxShadow: '0 0 0 1px rgba(228,90,154,0.28), 0 0 10px rgba(228,90,154,0.18)',
        borderColor: 'rgba(228,90,154,0.4)',
        duration: 1.15,
      })
    tls.push(pulse)

    if (glow) {
      const shimmer = gsap.timeline({ repeat: -1, defaults: { ease: 'none' }, delay: index * 0.2 })
      shimmer.fromTo(
        glow,
        { xPercent: -120, opacity: 0 },
        { xPercent: 120, opacity: 0.9, duration: 1.8, repeatDelay: 1.6 },
      )
      tls.push(shimmer)
    }

    if (badge) {
      const bob = gsap.timeline({ repeat: -1, yoyo: true, defaults: { ease: 'sine.inOut' } })
      bob.fromTo(badge, { y: 0, scale: 1 }, { y: -2, scale: 1.06, duration: 0.7 })
      tls.push(bob)
    }

    spotlightTls.set(el, tls)
  })
}

export function pauseNavSpotlight(el: HTMLElement | null, paused: boolean) {
  if (!el) return
  const tls = spotlightTls.get(el)
  if (!tls) return
  tls.forEach((tl) => {
    if (paused) tl.pause(0)
    else tl.play()
  })
  if (paused) {
    gsap.set(el, {
      boxShadow: '0 0 0 1px rgba(228,90,154,0.35), 0 0 12px rgba(228,90,154,0.2)',
      borderColor: 'rgba(228,90,154,0.45)',
    })
  }
}
