import gsap from 'gsap'

export function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function runEnterShell(root: HTMLElement) {
  if (prefersReducedMotion()) {
    gsap.set(root.querySelectorAll('[data-motion]'), { clearProps: 'all', opacity: 1, y: 0 })
    return
  }
  const tl = gsap.timeline({ defaults: { ease: 'power3.out' } })
  tl.fromTo(
    root.querySelector('[data-motion="sidebar"]'),
    { opacity: 0, x: -24 },
    { opacity: 1, x: 0, duration: 0.55 },
  ).fromTo(
    root.querySelector('[data-motion="main"]'),
    { opacity: 0, y: 18, filter: 'blur(6px)' },
    { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.6 },
    '-=0.35',
  )
}

export function runEmailPageEnter(scope: HTMLElement) {
  if (prefersReducedMotion()) return
  const tl = gsap.timeline({ defaults: { ease: 'power3.out' } })
  tl.fromTo(
    scope.querySelector('[data-motion="toolbar"]'),
    { opacity: 0, y: -12 },
    { opacity: 1, y: 0, duration: 0.4 },
  ).fromTo(
    scope.querySelectorAll('[data-motion="card"]'),
    { opacity: 0, y: 22, scale: 0.97 },
    { opacity: 1, y: 0, scale: 1, duration: 0.45, stagger: 0.045 },
    '-=0.15',
  )
}

export function pulseCodeReveal(el: HTMLElement) {
  if (prefersReducedMotion()) return
  gsap.fromTo(
    el.querySelectorAll('[data-digit]'),
    { opacity: 0, y: 10 },
    { opacity: 1, y: 0, stagger: 0.05, duration: 0.28, ease: 'back.out(1.6)' },
  )
  gsap.fromTo(
    el,
    { boxShadow: '0 0 0 rgba(228,90,154,0)' },
    { boxShadow: '0 0 28px rgba(228,90,154,0.35)', duration: 0.35, yoyo: true, repeat: 1 },
  )
}
