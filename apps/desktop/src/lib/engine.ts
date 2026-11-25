import { tr } from '@/lib/i18n'
/**
 * Bridge to the Rust engine.
 *
 * Everything audio-related lives in Rust: capture, resampling, VAD and ASR.
 * The WebView only ever receives text and level numbers through this channel.
 * When the app is opened in a plain browser (`pnpm dev`), a clearly-labelled
 * demo source stands in so the interface can be worked on without the shell.
 */

import { Channel, invoke } from '@tauri-apps/api/core'

export type EngineState = 'idle' | 'starting' | 'listening' | 'paused' | 'error'

export type EngineEvent =
  | {
      type: 'status'
      state: EngineState
      message?: string | null
      source?: string | null
      sampleRate?: number
    }
  | { type: 'level'; rms: number; peak: number }
  | { type: 'partial'; id: number; text: string; startMs: number }
  | { type: 'final'; id: number; text: string; startMs: number; endMs: number }
  | { type: 'translationDelta'; id: number; text: string }
  | {
      type: 'translationDone'
      id: number
      text: string
      route: string
      provider?: string | null
      ms: number
      fallback: boolean
    }
  | { type: 'translationError'; id: number; code: string; message: string }
  | { type: 'error'; message: string }

export type EngineController = {
  stop: () => void
  pause: () => void
  resume: () => void
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Re-run translation for one sentence; retry is an explicit user action. */
export async function retranslateSegment(
  id: number,
  onEvent: (event: EngineEvent) => void,
): Promise<void> {
  if (!isTauri()) return
  const channel = new Channel<EngineEvent>()
  channel.onmessage = onEvent
  await invoke('retranslate_segment', { id, channel })
}

export async function startEngine(
  onEvent: (event: EngineEvent) => void,
): Promise<EngineController> {
  if (!isTauri()) {
    return startDemoEngine(onEvent)
  }

  const channel = new Channel<EngineEvent>()
  channel.onmessage = onEvent

  await invoke('start_listening', { channel })

  return {
    stop: () => {
      channel.onmessage = () => {}
      void invoke('stop_listening').catch(() => {})
    },
    pause: () => {
      void invoke('pause_listening').catch(() => {})
    },
    resume: () => {
      void invoke('resume_listening').catch(() => {})
    },
  }
}

/* ------------------------------------------------------------------------- */
/* Demo source — browser preview only                                        */
/* ------------------------------------------------------------------------- */

const DEMO_LINES: { text: string; finalMs: number; translation: string }[] = [
  {
    text: 'Good morning. Today we are going to look at how a streaming caption pipeline actually works.',
    finalMs: 2600,
    translation: tr("早上好。今天我们要看看一条流式字幕链路到底是怎么运作的。"),
  },
  {
    text: tr("整条链路只有四步：采集、重采样、语音活动检测，然后是流式解码。"),
    finalMs: 3000,
    translation: '',
  },
  {
    text: 'The important bit is that we never wait for a whole sentence before showing something.',
    finalMs: 2400,
    translation: tr("关键在于，我们从不等到整句结束才开始显示内容。"),
  },
  {
    text: tr("每一句在静音处收束，随后才会带着上下文进入翻译队列。"),
    finalMs: 2800,
    translation: '',
  },
  {
    text: 'And that sentence-level boundary is what makes the translation usable instead of word soup.',
    finalMs: 2700,
    translation: tr("正是这个句子边界，让译文可读，而不是一堆词渣。"),
  },
]

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function startDemoEngine(onEvent: (event: EngineEvent) => void): EngineController {
  let cancelled = false
  let paused = false

  const levelTimer = window.setInterval(() => {
    if (cancelled || paused) return
    const base = 0.12 + Math.random() * 0.5
    onEvent({ type: 'level', rms: base, peak: Math.min(1, base + Math.random() * 0.25) })
  }, 110)

  void (async () => {
    onEvent({
      type: 'status',
      state: 'starting',
      message: 'Demo source · no audio device is opened in the browser preview.',
      source: 'Demo audio',
      sampleRate: 16000,
    })
    await sleep(500)
    if (cancelled) return
    onEvent({ type: 'status', state: 'listening', source: 'Demo audio', sampleRate: 16000 })

    let id = 1
    let clock = 0
    while (!cancelled) {
      for (const line of DEMO_LINES) {
        if (cancelled) return
        const startMs = clock
        const steps = Math.max(3, Math.ceil(line.text.length / 14))
        for (let step = 1; step <= steps; step += 1) {
          if (cancelled) return
          const cut = Math.round((line.text.length * step) / steps)
          onEvent({
            type: 'partial',
            id,
            text: line.text.slice(0, cut),
            startMs,
          })
          await sleep(line.finalMs / steps)
        }
        if (cancelled) return
        const endMs = startMs + line.finalMs
        onEvent({ type: 'final', id, text: line.text, startMs, endMs })
        await sleep(220)
        if (cancelled) return
        if (line.translation) {
          const steps = 3
          for (let step = 1; step <= steps; step += 1) {
            if (cancelled) return
            const cut = Math.round((line.translation.length * step) / steps)
            onEvent({
              type: 'translationDelta',
              id,
              text: line.translation.slice(0, cut),
            })
            await sleep(70)
          }
          onEvent({
            type: 'translationDone',
            id,
            text: line.translation,
            route: 'nmt',
            ms: 380 + Math.round(Math.random() * 220),
            fallback: false,
          })
        } else {
          onEvent({
            type: 'translationDone',
            id,
            text: '',
            route: 'passthrough',
            ms: 0,
            fallback: false,
          })
        }
        clock = endMs + 700
        id += 1
        await sleep(500)
      }
      await sleep(1200)
    }
  })()

  return {
    stop: () => {
      cancelled = true
      window.clearInterval(levelTimer)
      onEvent({ type: 'status', state: 'idle', source: null })
    },
    pause: () => {
      paused = true
      onEvent({ type: 'status', state: 'paused' })
    },
    resume: () => {
      paused = false
      onEvent({ type: 'status', state: 'listening' })
    },
  }
}
