import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

const CARD_MIN = 240
const GAP = 12

export function VirtualAccountGrid<T extends { id: string }>({
  items,
  estimateSize = 108,
  renderItem,
}: {
  items: T[]
  estimateSize?: number
  renderItem: (item: T) => ReactNode
}) {
  const parentRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const el = parentRef.current
    if (!el) return
    const apply = () => setWidth(el.clientWidth)
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const columns = Math.max(1, Math.floor((Math.max(width, CARD_MIN) + GAP) / (CARD_MIN + GAP)))
  const rowCount = Math.max(1, Math.ceil(items.length / columns))
  const rowH = estimateSize + GAP

  const virtualizer = useVirtualizer({
    count: items.length ? rowCount : 0,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowH,
    overscan: 4,
  })

  if (!items.length) return null

  return (
    <div ref={parentRef} className="card-grid virtual-card-grid">
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((vRow) => {
          const start = vRow.index * columns
          const slice = items.slice(start, start + columns)
          return (
            <div
              key={vRow.key}
              className="virtual-card-row"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vRow.start}px)`,
                display: 'grid',
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                gap: GAP,
              }}
            >
              {slice.map((item) => (
                <div key={item.id}>{renderItem(item)}</div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

