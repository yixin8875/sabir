import { useCallback, useEffect, useRef, useState } from 'react'
import {
  isTauri,
  retranslateSegment,
  startEngine,
  type EngineController,
  type EngineEvent,
  type EngineState,
} from '@/lib/engine'

export type TranscriptSegment = {
  id: number
  text: string
  startMs: number
  endMs: number
}

export type InterimSegment = {
  id: number
  text: string
  startMs: number
}

export type SegmentTranslation = {
  status: 'pending' | 'streaming' | 'done' | 'error' | 'skipped'
  text: string
  route?: string
  provider?: string | null
  ms?: number
  fallback?: boolean
  code?: string
  message?: string
}

type UseEngineOptions = {
  translateEnabled?: boolean
  /** Called for each finished translation, e.g. to speak it aloud. */
  onTranslationDone?: (text: string) => void
}

export function useEngine(options: UseEngineOptions = {}) {
  const translateEnabled = options.translateEnabled ?? true
  const onTranslationDoneRef = useRef(options.onTranslationDone)

  useEffect(() => {
    onTranslationDoneRef.current = options.onTranslationDone
  }, [options.onTranslationDone])
  const [state, setState] = useState<EngineState>('idle')
  const [source, setSource] = useState<string | null>(null)
  const [sampleRate, setSampleRate] = useState<number | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [level, setLevel] = useState({ rms: 0, peak: 0 })
  const [finals, setFinals] = useState<TranscriptSegment[]>([])
  const [interim, setInterim] = useState<InterimSegment | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [translations, setTranslations] = useState<
    Record<number, SegmentTranslation>
  >({})

  const controllerRef = useRef<EngineController | null>(null)
  const busyRef = useRef(false)
  const startedAtRef = useRef<number | null>(null)
  const pausedElapsedRef = useRef(0)
  const translateEnabledRef = useRef(translateEnabled)

  useEffect(() => {
    translateEnabledRef.current = translateEnabled
  }, [translateEnabled])

  useEffect(() => {
    if (state === 'paused') {
      // Freeze the clock and keep the transcript; resume picks up from here.
      if (startedAtRef.current !== null) {
        pausedElapsedRef.current = Date.now() - startedAtRef.current
        startedAtRef.current = null
      }
      return
    }
    if (state !== 'listening' && state !== 'starting') {
      startedAtRef.current = null
      pausedElapsedRef.current = 0
      return
    }
    if (startedAtRef.current === null) {
      startedAtRef.current = Date.now() - pausedElapsedRef.current
    }
    const timer = window.setInterval(() => {
      if (startedAtRef.current !== null) {
        setElapsedMs(Date.now() - startedAtRef.current)
      }
    }, 250)
    return () => window.clearInterval(timer)
  }, [state])

  useEffect(() => {
    return () => {
      controllerRef.current?.stop()
      controllerRef.current = null
    }
  }, [])

  const handleEvent = useCallback((event: EngineEvent) => {
    switch (event.type) {
      case 'status': {
        setState(event.state)
        // Capture reports the device once; the ASR "listening" status omits it.
        if (event.source !== undefined) setSource(event.source)
        if (event.sampleRate !== undefined) setSampleRate(event.sampleRate)
        setMessage(event.message ?? null)
        if (event.state === 'paused') {
          setLevel({ rms: 0, peak: 0 })
        }
        if (event.state === 'idle' || event.state === 'error') {
          setLevel({ rms: 0, peak: 0 })
          setInterim(null)
          setElapsedMs(0)
        }
        break
      }
      case 'level': {
        setLevel({ rms: event.rms, peak: event.peak })
        break
      }
      case 'partial': {
        setInterim({ id: event.id, text: event.text, startMs: event.startMs })
        break
      }
      case 'final': {
        setFinals((prev) => {
          if (prev.some((segment) => segment.id === event.id)) return prev
          return [
            ...prev,
            {
              id: event.id,
              text: event.text,
              startMs: event.startMs,
              endMs: event.endMs,
            },
          ]
        })
        setInterim((current) => (current?.id === event.id ? null : current))
        if (translateEnabledRef.current) {
          setTranslations((prev) =>
            prev[event.id]
              ? prev
              : { ...prev, [event.id]: { status: 'pending', text: '' } },
          )
        }
        break
      }
      case 'translationDelta': {
        setTranslations((prev) => ({
          ...prev,
          [event.id]: { ...prev[event.id], status: 'streaming', text: event.text },
        }))
        break
      }
      case 'translationDone': {
        setTranslations((prev) => ({
          ...prev,
          [event.id]: {
            status: event.route === 'passthrough' ? 'skipped' : 'done',
            text: event.text,
            route: event.route,
            provider: event.provider ?? null,
            ms: event.ms,
            fallback: event.fallback,
          },
        }))
        if (event.route !== 'passthrough' && event.text.trim()) {
          onTranslationDoneRef.current?.(event.text)
        }
        break
      }
      case 'translationError': {
        setTranslations((prev) => ({
          ...prev,
          [event.id]: {
            status: 'error',
            text: '',
            code: event.code,
            message: event.message,
          },
        }))
        break
      }
      case 'error': {
        setError(event.message)
        setState('error')
        setLevel({ rms: 0, peak: 0 })
        break
      }
    }
  }, [])

  const start = useCallback(async () => {
    if (
      busyRef.current ||
      state === 'listening' ||
      state === 'starting' ||
      state === 'paused'
    ) {
      return
    }
    busyRef.current = true
    setError(null)
    setState('starting')
    try {
      controllerRef.current = await startEngine(handleEvent)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setState('error')
      controllerRef.current = null
    } finally {
      busyRef.current = false
    }
  }, [handleEvent, state])

  const pause = useCallback(() => {
    if (state !== 'listening') return
    controllerRef.current?.pause()
  }, [state])

  const resume = useCallback(() => {
    if (state !== 'paused') return
    controllerRef.current?.resume()
  }, [state])

  const stop = useCallback(() => {
    controllerRef.current?.stop()
    controllerRef.current = null
    busyRef.current = false
    pausedElapsedRef.current = 0
    setState('idle')
    setSource(null)
    setSampleRate(null)
    setMessage(null)
    setLevel({ rms: 0, peak: 0 })
    setInterim(null)
  }, [])

  const retryTranslation = useCallback(
    async (id: number) => {
      setTranslations((prev) => ({
        ...prev,
        [id]: { status: 'pending', text: '' },
      }))
      try {
        await retranslateSegment(id, handleEvent)
      } catch (cause) {
        setTranslations((prev) => ({
          ...prev,
          [id]: {
            status: 'error',
            text: '',
            code: 'request_failed',
            message: cause instanceof Error ? cause.message : String(cause),
          },
        }))
      }
    },
    [handleEvent],
  )

  const clear = useCallback(() => {
    setFinals([])
    setInterim(null)
    setTranslations({})
  }, [])

  return {
    state,
    source,
    sampleRate,
    message,
    level,
    finals,
    interim,
    translations,
    elapsedMs,
    error,
    isDemo: !isTauri(),
    start,
    stop,
    pause,
    resume,
    clear,
    retryTranslation,
  }
}
