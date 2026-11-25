import { tr } from '@/lib/i18n'
import { useEffect, useState } from 'react'
import { emit, listen } from '@tauri-apps/api/event'
import { GripVertical, Pause, Play, Square } from 'lucide-react'
import { isTauri } from '@/lib/engine'
import { cn } from '@/lib/utils'

type FloatState = 'idle' | 'starting' | 'listening' | 'paused' | 'error'

type FloatStatus = {
  state: FloatState
  elapsedMs: number
  source: string
}

const IDLE_STATUS: FloatStatus = {
  state: 'idle',
  elapsedMs: 0,
  source: tr("系统声音"),
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}

function send(action: 'pause' | 'resume' | 'stop' | 'focus') {
  void emit('livetrans:float-action', action).catch(() => {})
}

/**
 * The transparent always-on-top pill shown while recording. It never drives
 * the engine itself: every button forwards an event to the main window, which
 * owns the engine state machine.
 */
export function LiveIndicator() {
  const [status, setStatus] = useState<FloatStatus>(IDLE_STATUS)

  useEffect(() => {
    if (!isTauri()) return
    const unlisten = listen<FloatStatus>('livetrans:float-status', (event) => {
      setStatus(event.payload)
    }).catch(() => null)
    return () => {
      void unlisten.then((off) => off?.())
    }
  }, [])

  const paused = status.state === 'paused'
  const starting = status.state === 'starting'
  const active = status.state === 'listening' || paused || starting

  return (
    <div className="flex h-dvh items-center justify-center p-1.5">
      <div
        data-tauri-drag-region
        className="flex w-full items-center gap-1.5 rounded-full border border-white/10 bg-zinc-900/95 py-1.5 pr-1.5 pl-2 text-zinc-100 shadow-[0_12px_32px_rgba(0,0,0,0.38)] backdrop-blur-md"
      >
        <span
          data-tauri-drag-region
          className="shrink-0 pl-0.5 text-zinc-600"
          aria-hidden="true"
        >
          <GripVertical className="size-4" />
        </span>

        <span
          aria-hidden="true"
          className={cn(
            'size-2 shrink-0 rounded-full',
            paused && 'bg-amber-400',
            status.state === 'listening' && 'animate-pulse bg-emerald-400',
            starting && 'animate-pulse bg-zinc-400',
            !active && 'bg-zinc-500',
          )}
        />

        <button
          type="button"
          onClick={() => send('focus')}
          title={tr("打开 Livetrans 主窗口")}
          className="min-w-0 flex-1 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-white/5"
        >
          <span className="block font-mono text-sm leading-5 font-medium tabular-nums">
            {formatElapsed(status.elapsedMs)}
          </span>
          <span className="block truncate text-[10px] leading-4 text-zinc-400">
            {starting ? tr("正在准备…") : paused ? tr("已暂停 · ") : ''}
            {status.source}
          </span>
        </button>

        <button
          type="button"
          disabled={starting}
          onClick={() => send(paused ? 'resume' : 'pause')}
          aria-label={paused ? tr("继续记录") : tr("暂停记录")}
          title={paused ? tr("继续记录") : tr("暂停记录")}
          className="grid size-8 shrink-0 place-items-center rounded-full text-zinc-300 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40"
        >
          {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
        </button>

        <button
          type="button"
          onClick={() => send('stop')}
          aria-label={tr("停止记录")}
          title={tr("停止记录")}
          className="grid size-8 shrink-0 place-items-center rounded-full text-zinc-300 transition-colors hover:bg-red-500/20 hover:text-red-300"
        >
          <Square className="size-3.5 fill-current" />
        </button>
      </div>
    </div>
  )
}
