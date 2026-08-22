import { useEmailStore } from '../store/emailStore'
import { maskSecret } from '../lib/parseAccounts'

type Props = {
  label: string
  value?: string
  revealed: boolean
  empty?: string
  mono?: boolean
}

/** 凭证字段：默认脱敏，revealed 时明文 + 点击复制 */
export function CredentialField({ label, value, revealed, empty = '—', mono = true }: Props) {
  const setToast = useEmailStore((s) => s.setToast)
  const text = (value || '').trim()
  if (!text) return <span style={{ opacity: 0.55 }}>{empty}</span>

  const display = revealed ? text : maskSecret(text)

  if (!revealed) {
    return (
      <span
        className="credential-masked"
        style={mono ? { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.82rem' } : undefined}
      >
        {display}
      </span>
    )
  }

  return (
    <button
      type="button"
      className="credential-reveal"
      title={`点击复制${label}`}
      onClick={(e) => {
        e.stopPropagation()
        void navigator.clipboard.writeText(text).then(
          () => setToast(`已复制${label}`),
          () => setToast(`复制${label}失败`),
        )
      }}
    >
      <span className="credential-copy-hint">复制</span>
      <span className="credential-value">{display}</span>
    </button>
  )
}
