import { useCallback, useEffect, useState } from 'react'
import {
  DEFAULT_ASR_SETTINGS,
  getAsrSettings,
  type AsrSettingsView,
} from '@/lib/asr'

/**
 * Loads the recognition settings (selected model, threads, catalogue state).
 * Rust owns the real values; this hook mirrors them and refreshes on demand.
 */
export function useAsrSettings() {
  const [view, setView] = useState<AsrSettingsView | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setView(await getAsrSettings())
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
    settings: view?.settings ?? DEFAULT_ASR_SETTINGS,
    ready: Boolean(view?.ready),
    modelsRoot: view?.modelsRoot ?? '',
    error,
    reload,
    setView,
  }
}
