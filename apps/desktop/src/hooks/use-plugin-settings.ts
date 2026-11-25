import { useCallback, useEffect, useState } from 'react'
import {
  getPluginSettings,
  type PluginSettingsView,
} from '@/lib/plugins'

/**
 * Loads the local plugin settings and keeps the view the settings dialog and
 * tests share. Saving happens in the panel's staged form, like voice settings.
 */
export function usePluginSettings() {
  const [view, setView] = useState<PluginSettingsView | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setView(await getPluginSettings())
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
    settings: view?.settings ?? { enabled: false, command: '' },
    error,
    reload,
    setView,
  }
}
