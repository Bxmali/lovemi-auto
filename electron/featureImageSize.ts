/** Lovemi Image1-pro 宽高比 × 画质（MP）→ 宽高，对齐官网 intimacy_lab */

export const FEATURE_ASPECTS = ['4:5', '5:4', '9:16', '16:9', '1:1'] as const
export type FeatureAspect = (typeof FEATURE_ASPECTS)[number]

export const FEATURE_MPS = [1, 1.5, 2, 2.5, 3] as const
export type FeatureMp = (typeof FEATURE_MPS)[number]

/** 官网已知精确尺寸优先 */
const KNOWN: Partial<Record<`${FeatureAspect}@${FeatureMp}`, { width: number; height: number }>> = {
  '16:9@3': { width: 2304, height: 1280 },
  '9:16@2': { width: 1088, height: 1920 },
  '1:1@2': { width: 1408, height: 1408 },
  '4:5@2': { width: 1280, height: 1600 },
  '5:4@2': { width: 1600, height: 1280 },
}

function round64(n: number) {
  return Math.max(64, Math.round(n / 64) * 64)
}

export function isFeatureAspect(value: unknown): value is FeatureAspect {
  return typeof value === 'string' && (FEATURE_ASPECTS as readonly string[]).includes(value)
}

export function isFeatureMp(value: unknown): value is FeatureMp {
  return typeof value === 'number' && (FEATURE_MPS as readonly number[]).includes(value)
}

export function resolveFeatureImageSize(aspect: FeatureAspect, mp: FeatureMp) {
  const known = KNOWN[`${aspect}@${mp}`]
  if (known) {
    return {
      aspect_ratio: aspect,
      width: known.width,
      height: known.height,
      megapixels: mp,
    }
  }
  const [aw, ah] = aspect.split(':').map(Number) as [number, number]
  const pixels = mp * 1_000_000
  let width = round64(Math.sqrt(pixels * (aw / ah)))
  let height = round64(width * (ah / aw))
  // 纠正比例漂移：以较长边为准重算另一边
  if (aw >= ah) {
    height = round64((width * ah) / aw)
  } else {
    width = round64((height * aw) / ah)
  }
  return {
    aspect_ratio: aspect,
    width,
    height,
    megapixels: mp,
  }
}
