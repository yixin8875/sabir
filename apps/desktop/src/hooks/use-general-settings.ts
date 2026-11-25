import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  applyUiScale,
  loadGeneralSettings,
  saveGeneralSettings,
  type GeneralSettings,
} from '@/lib/general'
import { isTauri } from '@/lib/engine'

/**
 * UI preferences shared by the top bar and the General settings page.
 * Always-on-top is mirrored into the Tauri window; the scale is applied as
 * Chromium zoom so every panel changes together.
 */
export function useGeneralSettings() {
  const [settings, setSettings] = useState<GeneralSettings>(loadGeneralSettings)

  useEffect(() => {
    applyUiScale(settings.uiScale)
  }, [settings.uiScale])

  useEffect(() => {
    if (!isTauri()) return
    void invoke('set_always_on_top', { enabled: settings.alwaysOnTop }).catch(
      () => {},
    )
  }, [settings.alwaysOnTop])

  const update = useCallback((patch: Partial<GeneralSettings>) => {
    setSettings((current) => saveGeneralSettings({ ...current, ...patch }))
  }, [])

  const replace = useCallback((next: GeneralSettings) => {
    setSettings(saveGeneralSettings(next))
  }, [])

  return { settings, update, replace }
}
