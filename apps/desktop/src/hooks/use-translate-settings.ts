import { useCallback, useEffect, useState } from 'react'
import {
  DEFAULT_TRANSLATE_SETTINGS,
  getTranslateSettings,
  type TranslateSettingsView,
} from '@/lib/translation'

/**
 * Loads the translation settings once and keeps the editor in sync. The Rust
 * side is the source of truth; this hook only mirrors its redacted view.
 */
export function useTranslateSettings() {
  const [view, setView] = useState<TranslateSettingsView | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setView(await getTranslateSettings())
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  return {
    view,
    settings: view?.settings ?? DEFAULT_TRANSLATE_SETTINGS,
    error,
    reload,
    setView,
  }
}
