import { useEffect, useRef, type CSSProperties } from 'react'
import gsap from 'gsap'

type Props = {
  src: string
  kind?: 'image' | 'video'
  onClose: () => void
}

/** GSAP 淡入缩放弹窗；横版大图需完整可见，勿用 overflow:hidden + 过窄 maxWidth 裁切 */
export function MediaLightbox({ src, kind = 'image', onClose }: Props) {
  const backdropRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const backdrop = backdropRef.current
    const panel = panelRef.current
    if (!backdrop || !panel) return
    const tl = gsap.timeline()
    gsap.set(backdrop, { opacity: 0 })
    gsap.set(panel, { opacity: 0, scale: 0.88, y: 16 })
    tl.to(backdrop, { opacity: 1, duration: 0.22, ease: 'power2.out' }, 0).to(
      panel,
      { opacity: 1, scale: 1, y: 0, duration: 0.32, ease: 'power3.out' },
      0.04,
    )
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      tl.kill()
    }
  }, [])

  const closeWithAnim = () => {
    const backdrop = backdropRef.current
    const panel = panelRef.current
    if (!backdrop || !panel) {
      onCloseRef.current()
      return
    }
    gsap
      .timeline({ onComplete: () => onCloseRef.current() })
      .to(panel, { opacity: 0, scale: 0.92, y: 10, duration: 0.18, ease: 'power2.in' }, 0)
      .to(backdrop, { opacity: 0, duration: 0.2, ease: 'power2.in' }, 0)
  }

  const mediaStyle: CSSProperties = {
    display: 'block',
    maxWidth: 'min(96vw, 1600px)',
    maxHeight: 'calc(100vh - 48px)',
    width: 'auto',
    height: 'auto',
    objectFit: 'contain',
  }

  return (
    <div
      ref={backdropRef}
      role="dialog"
      aria-modal="true"
      onClick={closeWithAnim}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(8, 6, 12, 0.78)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        cursor: 'zoom-out',
        boxSizing: 'border-box',
      }}
    >
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: 'min(96vw, 1600px)',
          maxHeight: 'calc(100vh - 48px)',
          borderRadius: 14,
          overflow: 'visible',
          boxShadow: '0 24px 80px rgba(0,0,0,0.45)',
          background: '#120e16',
          cursor: 'default',
          lineHeight: 0,
        }}
      >
        {kind === 'video' ? (
          <video
            key={src}
            src={src}
            controls
            autoPlay
            playsInline
            onLoadedData={(e) => {
              void e.currentTarget.play().catch(() => {})
            }}
            style={mediaStyle}
          />
        ) : (
          <img src={src} alt="preview" draggable={false} style={mediaStyle} />
        )}
      </div>
    </div>
  )
}
