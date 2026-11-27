/**
 * Preferences Rust owns: the export folder and the interface language.
 *
 * The language is also mirrored into localStorage by `setLocale` because the
 * UI reads it synchronously at import time; Rust keeps it so exports and
 * backend messages can follow the same choice.
 */
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './engine'
import { currentLocale, normalizeLocale, tr, type Locale } from './i18n'

export type AppSettings = {
  exportDir: string | null
  locale: Locale
  minimizeToTray: boolean
  /** Write a Markdown note into `exportDir` every time a session ends. */
  autoSaveNotes: boolean
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  exportDir: null,
  locale: 'zh-Hans',
  minimizeToTray: true,
  autoSaveNotes: true,
}

const STORAGE_KEY = 'sabir-app-settings'

export function normalizeAppSettings(
  value: Partial<AppSettings> | null | undefined,
): AppSettings {
  const dir =
    typeof value?.exportDir === 'string' ? value.exportDir.trim() : ''
  return {
    exportDir: dir || null,
    locale: normalizeLocale(value?.locale),
    minimizeToTray: value?.minimizeToTray !== false,
    autoSaveNotes: value?.autoSaveNotes !== false,
  }
}

export async function getAppSettings(): Promise<AppSettings> {
  if (!isTauri()) {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) return { ...DEFAULT_APP_SETTINGS, locale: currentLocale() }
      return normalizeAppSettings(JSON.parse(raw))
    } catch {
      return { ...DEFAULT_APP_SETTINGS }
    }
  }
  return normalizeAppSettings(await invoke<AppSettings>('get_general_settings'))
}

export async function saveAppSettings(
  settings: AppSettings,
): Promise<AppSettings> {
  const next = normalizeAppSettings(settings)
  if (!isTauri()) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    return next
  }
  return normalizeAppSettings(
    await invoke<AppSettings>('save_general_settings', { settings: next }),
  )
}

export async function pickExportDir(
  title: string = tr('选择导出目录'),
): Promise<string | null> {
  if (!isTauri()) return null
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({
    directory: true,
    multiple: false,
    title,
  })
  return typeof picked === 'string' ? picked : null
}
