import { useCallback, useEffect, useRef, useState } from 'react'
import { isTauri } from '@/lib/engine'
import {
  getVoiceSettings,
  saveVoiceSettings,
  synthesizeVoice,
  type VoiceSettings,
  type VoiceSettingsView,
} from '@/lib/voice'

/** Sentences waiting behind the one being spoken; beyond this we skip ahead. */
const MAX_QUEUED = 6

type QueueItem = {
  text: string
  lang: string
}

function synthesisLang(lang: string): string {
  return lang.trim().toLowerCase().startsWith('en') ? 'en' : 'zh'
}

function browserLang(lang: string): string {
  const value = lang.trim().toLowerCase()
  if (value.startsWith('en')) return 'en-US'
  if (value === 'zh-hant') return 'zh-TW'
  return 'zh-CN'
}

/**
 * Speaks completed translations in order.
 *
 * The WebView asks Rust to synthesise one sentence at a time, then plays the
 * returned WAV; the next sentence starts when the current one ends. Playback is
 * dropped while voiceover is off, the model is missing, or the engine is not
 * listening.
 */
export function useVoice() {
  const [view, setView] = useState<VoiceSettingsView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const viewRef = useRef<VoiceSettingsView | null>(null)
  const queueRef = useRef<QueueItem[]>([])
  const busyRef = useRef(false)
  const generationRef = useRef(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null)
  const pumpRef = useRef<() => void>(() => {})

  viewRef.current = view

  const reload = useCallback(async () => {
    try {
      setView(await getVoiceSettings())
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const stop = useCallback(() => {
    generationRef.current += 1
    queueRef.current = []
    busyRef.current = false
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    utteranceRef.current = null
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel()
    }
  }, [])

  const update = useCallback(
    async (settings: VoiceSettings) => {
      const next = await saveVoiceSettings(settings)
      setView(next)
      if (!next.settings.enabled) stop()
      return next
    },
    [stop],
  )

  pumpRef.current = () => {
    if (busyRef.current) return
    const current = viewRef.current
    if (!current?.settings.enabled || !current.model.installed) {
      queueRef.current = []
      return
    }
    const next = queueRef.current.shift()
    if (!next) return
    busyRef.current = true
    const generation = generationRef.current

    const finish = () => {
      if (generation !== generationRef.current) return
      busyRef.current = false
      pumpRef.current()
    }

    if (!isTauri()) {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
        finish()
        return
      }
      const utterance = new SpeechSynthesisUtterance(next.text)
      utterance.lang = browserLang(next.lang)
      utterance.onend = finish
      utterance.onerror = finish
      utteranceRef.current = utterance
      window.speechSynthesis.speak(utterance)
      return
    }

    void synthesizeVoice(next.text, synthesisLang(next.lang))
      .then((audio) => {
        if (generation !== generationRef.current) return
        if (!audio) {
          finish()
          return
        }
        const player = new Audio(`data:audio/wav;base64,${audio}`)
        audioRef.current = player
        player.onended = () => {
          if (audioRef.current === player) audioRef.current = null
          finish()
        }
        player.onerror = () => {
          if (audioRef.current === player) audioRef.current = null
          finish()
        }
        void player.play().catch(() => {
          if (audioRef.current === player) audioRef.current = null
          finish()
        })
      })
      .catch(() => {
        if (generation === generationRef.current) finish()
      })
  }

  /** Queue one finished translation. Language is the translation target. */
  const speak = useCallback((text: string, lang: string) => {
    const current = viewRef.current
    if (!current?.settings.enabled || !current.model.installed) return
    const clean = text.trim()
    if (!clean) return
    if (queueRef.current.length >= MAX_QUEUED) return
    queueRef.current.push({ text: clean, lang })
    pumpRef.current()
  }, [])

  return {
    view,
    settings: view?.settings ?? { enabled: false },
    enabled: Boolean(view?.settings.enabled),
    installed: Boolean(view?.model.installed),
    error,
    reload,
    setView,
    update,
    speak,
    stop,
  }
}
