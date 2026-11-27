import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/lib/engine'
import {
  DARK_THEMES,
  LIGHT_THEMES,
  applyAppearance,
  loadAppearance,
  resolveMode,
  saveAppearance,
  type Appearance,
  type ThemeMode,
} from '@/lib/appearance'

/**
 * Theme, mode and translucency, shared by the top bar and the Appearance
 * settings page. Every change applies and persists at once so the settings
 * dialog previews the palette while the user clicks through it.
 */
export function useAppearance() {
  const [appearance, setAppearance] = useState(loadAppearance)
  const [resolved, setResolved] = useState<ThemeMode>(() =>
    resolveMode(appearance),
  )

  useEffect(() => {
    setResolved(applyAppearance(appearance))
  }, [appearance])

  // While following the system, re-apply whenever Windows switches mode.
  useEffect(() => {
    if (!appearance.followSystem) return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setResolved(applyAppearance(appearance))
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [appearance])

  useEffect(() => {
    if (typeof document === 'undefined') return
    document.documentElement.classList.toggle(
      'lt-translucent',
      appearance.translucency,
    )
    if (!isTauri()) return
    void invoke('set_window_translucency', {
      enabled: appearance.translucency,
    }).catch(() => {})
  }, [appearance.translucency])

  const update = useCallback((patch: Partial<Appearance>) => {
    setAppearance((current) => saveAppearance({ ...current, ...patch }))
  }, [])

  /** Select one palette for its own light/dark slot. */
  const selectTheme = useCallback((id: string) => {
    setAppearance((current) => {
      const theme = [...LIGHT_THEMES, ...DARK_THEMES].find(
        (item) => item.id === id,
      )
      if (!theme) return current
      return saveAppearance({
        ...current,
        ...(theme.mode === 'dark'
          ? { dark: theme.id }
          : { light: theme.id }),
      })
    })
  }, [])

  /** The top-bar sun/moon button: flip the mode and stop following the system. */
  const toggleMode = useCallback(() => {
    setAppearance((current) =>
      saveAppearance({
        ...current,
        followSystem: false,
        mode: resolveMode(current) === 'dark' ? 'light' : 'dark',
      }),
    )
  }, [])

  return { appearance, resolved, update, selectTheme, toggleMode }
}
