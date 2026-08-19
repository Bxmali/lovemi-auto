export const LOCALES = ['zh', 'en', 'ja', 'ko', 'vi', 'th', 'es', 'ru', 'fil', 'fr'] as const
export type LocaleCode = (typeof LOCALES)[number]

export const LOCALE_LABEL: Record<LocaleCode, string> = {
  zh: '中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  vi: 'Tiếng Việt',
  th: 'ไทย',
  es: 'Español',
  ru: 'Русский',
  fil: 'Filipino',
  fr: 'Français',
}

export function localeLabel(code?: string) {
  if (!code) return '未分配语言'
  return (LOCALE_LABEL as Record<string, string>)[code] || code
}
