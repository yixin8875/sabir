/**
 * Small runtime translator. Chinese text is the key: call sites keep the
 * Chinese string and English comes from the dictionary, so an untranslated
 * string falls back to Chinese instead of showing a key name.
 *
 * Switching the language reloads the window (module-level labels in option
 * tables are built at import time), which keeps the implementation tiny.
 */
import { EN_MESSAGES } from './messages.en'

export type Locale = 'zh-Hans' | 'en'

const STORAGE_KEY = 'sabir-locale'

export function normalizeLocale(value: string | null | undefined): Locale {
  return value?.toLowerCase() === 'en' ? 'en' : 'zh-Hans'
}

/** Cached synchronously so module-level tables already render in the right language. */
export function currentLocale(): Locale {
  if (typeof window === 'undefined') return 'zh-Hans'
  return normalizeLocale(window.localStorage.getItem(STORAGE_KEY))
}

export function setLocale(locale: Locale) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, locale)
}

export function isEnglish(): boolean {
  return currentLocale() === 'en'
}

/** Replace `{name}` placeholders in a template. */
export function interpolate(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

/**
 * Translate a Chinese UI string. `params` fills `{name}` placeholders in both
 * the Chinese and the English template.
 */
export function tr(
  zh: string,
  params?: Record<string, string | number>,
): string {
  const template = isEnglish() ? (EN_MESSAGES[zh] ?? zh) : zh
  return interpolate(template, params)
}

/**
 * Best-effort translation for text that comes from Rust. Static messages hit
 * the dictionary; formatted or unrecognised messages are returned unchanged.
 */
export function localize(text: string): string {
  if (!isEnglish()) return text
  return EN_MESSAGES[text] ?? text
}
