import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_AUDIO_SETTINGS,
  getAudioSettings,
  saveAudioSettings,
  type AudioSettings,
} from '@/lib/audio'

/**
 * Audio source selection shared by the top-bar dropdown and the settings
 * dialog. Rust reloads audio.json at every start(), so saving here is enough
 * for the next session; the current capture is not disturbed.
 */
export function useAudioSettings() {
  const [settings, setSettings] = useState<AudioSettings>(
    DEFAULT_AUDIO_SETTINGS,
  )
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const reload = useCallback(async () => {
    try {
      const next = await getAudioSettings()
      setSettings(next)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const update = useCallback(async (patch: Partial<AudioSettings>) => {
    const next = { ...settingsRef.current, ...patch }
    setSettings(next)
    setError(null)
    try {
      const saved = await saveAudioSettings(next)
      setSettings(saved)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      try {
        const current = await getAudioSettings()
        setSettings(current)
      } catch {
        // Keep the optimistic value; the error is surfaced to the caller.
      }
    }
  }, [])

  return { settings, setSettings, update, reload, error, loaded }
}
