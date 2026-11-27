import { useEffect, useState } from 'react'
import { emit, listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { GripVertical, Maximize2, Minus, Plus, X } from 'lucide-react'
import { tr } from '@/lib/i18n'
import { isTauri, type EngineState } from '@/lib/engine'
import { cn } from '@/lib/utils'

export type CaptionLine = {
  id: number
  text: string
  translation: string | null
}

export type CaptionState = {
  state: EngineState
  source: string
  interim: string | null
  lines: CaptionLine[]
}

const IDLE: CaptionState = {
  state: 'idle',
  source: '',
  interim: null,
  lines: [],
}

const MIN_SIZE = 14
const MAX_SIZE = 34
const SIZE_KEY = 'sabir-overlay-size'
const POSITION_KEY = 'sabir-overlay-pos'

function initialSize() {
  if (typeof window === 'undefined') return 22
  const stored = Number(window.localStorage.getItem(SIZE_KEY))
  return Number.isFinite(stored) && stored >= MIN_SIZE && stored <= MAX_SIZE
    ? stored
    : 22
}

/**
 * The bilingual subtitle window. It never drives the engine: the main window
 * pushes finished and in-flight lines through `sabir:caption-state`, and the
 * only actions here are font size, focus and dismiss.
 */
export function CaptionOverlay() {
  const [size, setSize] = useState(initialSize)
  const [caption, setCaption] = useState<CaptionState>(IDLE)

  useEffect(() => {
    if (!isTauri()) return
    const unlisten = listen<CaptionState>('sabir:caption-state', (event) => {
      setCaption(event.payload)
    }).catch(() => null)
    return () => {
      void unlisten.then((off) => off?.())
    }
  }, [])

  // Rust applies the position on every show (it can do that before this
  // document is even ready); here we only remember where the user dragged the
  // bar so the next session opens in the same spot.
  useEffect(() => {
    if (!isTauri()) return
    const win = getCurrentWindow()
    const unlisten = win
      .onMoved(({ payload }) => {
        window.localStorage.setItem(POSITION_KEY, JSON.stringify(payload))
      })
      .catch(() => null)
    return () => {
      void unlisten.then((off) => off?.())
    }
  }, [])

  function changeSize(delta: number) {
    setSize((current) => {
      const next = Math.min(MAX_SIZE, Math.max(MIN_SIZE, current + delta))
      window.localStorage.setItem(SIZE_KEY, String(next))
      return next
    })
  }

  const paused = caption.state === 'paused'
  const starting = caption.state === 'starting'
  const empty = caption.lines.length === 0 && !caption.interim
  const subtitleSize = Math.max(MIN_SIZE, size - 3)

  return (
    <div className="flex h-dvh items-end justify-center px-3 pb-3">
      <div
        data-tauri-drag-region
        className="group relative w-full overflow-hidden rounded-2xl bg-zinc-950/85 px-6 py-4 text-zinc-100 shadow-[0_18px_48px_rgba(0,0,0,0.45)] ring-1 ring-white/10"
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center pt-1 opacity-0 transition-opacity group-hover:opacity-100">
          <GripVertical className="size-3.5 text-zinc-600" aria-hidden="true" />
        </div>

        <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={() => changeSize(-2)}
            aria-label={tr('调小字幕')}
            title={tr('调小字幕')}
            className="grid size-6 place-items-center rounded-md text-zinc-400 transition-colors hover:bg-white/10 hover:text-white"
          >
            <Minus className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => changeSize(2)}
            aria-label={tr('调大字幕')}
            title={tr('调大字幕')}
            className="grid size-6 place-items-center rounded-md text-zinc-400 transition-colors hover:bg-white/10 hover:text-white"
          >
            <Plus className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() =>
              void emit('sabir:float-action', 'focus').catch(() => {})
            }
            aria-label={tr('打开 Sabir 主窗口')}
            title={tr('打开 Sabir 主窗口')}
            className="grid size-6 place-items-center rounded-md text-zinc-400 transition-colors hover:bg-white/10 hover:text-white"
          >
            <Maximize2 className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void emit('sabir:caption-dismiss').catch(() => {})}
            aria-label={tr('关闭字幕浮窗')}
            title={tr('关闭字幕浮窗')}
            className="grid size-6 place-items-center rounded-md text-zinc-400 transition-colors hover:bg-red-500/20 hover:text-red-300"
          >
            <X className="size-3.5" />
          </button>
        </div>

        <div
          data-tauri-drag-region
          aria-live="polite"
          className="max-h-[calc(100dvh-2rem)] space-y-1.5 overflow-hidden pr-20"
        >
          {caption.lines.map((line, index) => (
            <div
              key={line.id}
              data-tauri-drag-region
              className={cn(
                'space-y-0.5',
                index < caption.lines.length - 1 && 'opacity-55',
              )}
            >
              <p
                data-tauri-drag-region
                className="caption-text line-clamp-2 leading-snug font-medium"
                style={{ fontSize: size }}
              >
                {line.text}
              </p>
              {line.translation && (
                <p
                  data-tauri-drag-region
                  className="caption-text line-clamp-2 leading-snug"
                  style={{ fontSize: subtitleSize, color: '#8FD0DD' }}
                >
                  {line.translation}
                </p>
              )}
            </div>
          ))}

          {caption.interim && (
            <p
              data-tauri-drag-region
              className="caption-text line-clamp-2 leading-snug text-zinc-400 italic"
              style={{ fontSize: subtitleSize }}
            >
              {caption.interim}
            </p>
          )}

          {empty && (
            <p
              className="flex items-center gap-2 text-zinc-400"
              style={{ fontSize: subtitleSize }}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  paused && 'bg-amber-400',
                  starting && 'animate-pulse bg-zinc-400',
                  !paused && !starting && 'animate-pulse bg-emerald-400',
                )}
              />
              {paused
                ? tr('已暂停')
                : starting
                  ? tr('正在准备…')
                  : tr('正在聆听…')}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
