/**
 * Small UI preferences that are not owned by the engine: always-on-top,
 * the floating recording indicator, and the interface scale. They live in
 * localStorage so they survive restarts without adding another Rust file.
 */

export type GeneralSettings = {
  alwaysOnTop: boolean
  floatEnabled: boolean
  uiScale: number
}

export const UI_SCALES = [90, 100, 110, 120] as const

export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  alwaysOnTop: false,
  floatEnabled: true,
  uiScale: 100,
}

const STORAGE_KEY = 'sabir-general'

function normalize(settings: GeneralSettings): GeneralSettings {
  const scale = Number(settings.uiScale)
  return {
    alwaysOnTop: Boolean(settings.alwaysOnTop),
    floatEnabled: Boolean(settings.floatEnabled),
    uiScale: Number.isFinite(scale)
      ? Math.min(150, Math.max(80, Math.round(scale)))
      : DEFAULT_GENERAL_SETTINGS.uiScale,
  }
}

export function loadGeneralSettings(): GeneralSettings {
  if (typeof window === 'undefined') return { ...DEFAULT_GENERAL_SETTINGS }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_GENERAL_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<GeneralSettings>
    return normalize({ ...DEFAULT_GENERAL_SETTINGS, ...parsed })
  } catch {
    return { ...DEFAULT_GENERAL_SETTINGS }
  }
}

export function saveGeneralSettings(
  settings: GeneralSettings,
): GeneralSettings {
  const next = normalize(settings)
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  return next
}

/** Apply the interface scale to the whole document (Chromium zoom). */
export function applyUiScale(scale: number) {
  if (typeof document === 'undefined') return
  const next = Math.min(150, Math.max(80, scale)) / 100
  document.documentElement.style.setProperty('zoom', String(next))
}
