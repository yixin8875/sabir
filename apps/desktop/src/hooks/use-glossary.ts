import { useCallback, useEffect, useRef, useState } from 'react'
import {
  defaultGlossary,
  loadGlossary,
  saveGlossary,
  type Glossary,
} from '@/lib/glossary'

/**
 * Keeps the active scene preset in sync between the home screen and settings.
 * Switching from the home screen persists only the selection.
 */
export function useGlossary() {
  const [glossary, setGlossaryState] = useState<Glossary>(defaultGlossary)
  const [error, setError] = useState<string | null>(null)
  const glossaryRef = useRef(glossary)
  glossaryRef.current = glossary

  const setGlossary = useCallback((next: Glossary) => {
    glossaryRef.current = next
    setGlossaryState(next)
  }, [])

  const reload = useCallback(async () => {
    try {
      setGlossary(await loadGlossary())
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [setGlossary])

  useEffect(() => {
    void reload()
  }, [reload])

  const setActive = useCallback(
    async (id: string) => {
      const current = glossaryRef.current
      if (current.activeId === id) return
      if (!current.presets.some((preset) => preset.id === id)) return
      const next = { ...current, activeId: id }
      setGlossary(next)
      try {
        setGlossary(await saveGlossary(next))
        setError(null)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
        await reload()
      }
    },
    [reload, setGlossary],
  )

  return { glossary, setGlossary, reload, setActive, error }
}
