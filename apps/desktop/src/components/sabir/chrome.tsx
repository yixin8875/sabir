import { tr } from '@/lib/i18n'
import {
  ArrowUp,
  AudioWaveform,
  BookOpen,
  CircleHelp,
  Languages,
  Moon,
  MonitorSpeaker,
  Pause,
  Pin,
  Settings2,
  ShieldCheck,
  Square,
  Sun,
  Play,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import type { AudioSource } from '@/lib/audio'
import { cn } from '@/lib/utils'
import type { EngineState } from '@/lib/engine'

/* ------------------------------------------------------------------------- */
/* Brand                                                                     */
/* ------------------------------------------------------------------------- */

export function LogoMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex size-6 items-center justify-center rounded-[7px] bg-primary text-primary-foreground',
        className,
      )}
    >
      <svg viewBox="0 0 20 20" className="size-3.5" fill="none">
        <path
          d="M3 10h1.6M6.6 6.4v7.2M10 3.4v13.2M13.4 6.4v7.2M17 10h-1.6"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    </span>
  )
}

/* ------------------------------------------------------------------------- */
/* Top bar                                                                   */
/* ------------------------------------------------------------------------- */

type TopBarProps = {
  theme: 'light' | 'dark'
  onToggleTheme: () => void
  onOpenSettings: () => void
  onOpenLibrary: () => void
  onOpenAbout: () => void
  pinned: boolean
  onTogglePin: () => void
  isDemo: boolean
  audioSource: AudioSource
  audioProcessId: number | null
  audioLocked: boolean
  onSelectAudioSource: (source: AudioSource) => void
  onOpenAudioSettings: () => void
}

export function TopBar({
  theme,
  onToggleTheme,
  onOpenSettings,
  onOpenLibrary,
  onOpenAbout,
  pinned,
  onTogglePin,
  isDemo,
  audioSource,
  audioProcessId,
  audioLocked,
  onSelectAudioSource,
  onOpenAudioSettings,
}: TopBarProps) {
  const audioItems = [
    { value: 'system', label: tr("系统声音") },
    { value: 'microphone', label: tr("麦克风") },
    { value: 'both', label: tr("系统声音 + 麦克风") },
    {
      value: 'process',
      label: audioProcessId ? tr("单个应用") : tr("选择单个应用…"),
    },
    { value: 'manage', label: tr("选择应用与设备…") },
  ]

  function changeAudioSource(value: string | null) {
    if (!value) return
    if (value === 'manage') {
      onOpenAudioSettings()
      return
    }
    if (value === 'process' && !audioProcessId) {
      onOpenAudioSettings()
      return
    }
    onSelectAudioSource(value as AudioSource)
  }

  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-border px-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <LogoMark />
        <span className="text-[15px] font-medium tracking-tight text-foreground">
          sabir
        </span>
        <Separator orientation="vertical" className="mx-1 h-4" />
        <span className="hidden truncate text-sm text-muted-foreground sm:inline">
          Live session
        </span>
        <Select
          value={audioSource}
          onValueChange={changeAudioSource}
          items={audioItems}
          disabled={audioLocked}
        >
          <SelectTrigger
            size="sm"
            aria-label={tr("音源")}
            title={audioLocked ? tr("停止后可切换音源") : tr("选择音源")}
            className="w-44 shrink-0 text-xs"
          >
            <MonitorSpeaker className="size-3.5 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectPopup align="start">
            {audioItems.slice(0, 4).map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
            <SelectSeparator />
            <SelectItem value="manage">{tr("选择应用与设备…")}</SelectItem>
          </SelectPopup>
        </Select>
        {isDemo && (
          <Badge variant="warning" size="sm">
            Demo source
          </Badge>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <span className="mr-1 hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
          <ShieldCheck className="size-3.5" />
          On-device
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={pinned ? tr("取消置顶") : tr("窗口置顶")}
          title={pinned ? tr("取消置顶") : tr("窗口置顶：让字幕压在其他窗口上方")}
          aria-pressed={pinned}
          onClick={onTogglePin}
          className={cn(
            'text-muted-foreground',
            pinned && 'bg-accent text-accent-foreground',
          )}
        >
          <Pin className={cn(pinned && 'rotate-45')} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={tr("会话库")}
          title={tr("会话库：本机保存的历次字幕")}
          onClick={onOpenLibrary}
          className="text-muted-foreground"
        >
          <BookOpen />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={tr("设置")}
          title={tr("设置")}
          onClick={onOpenSettings}
          className="text-muted-foreground"
        >
          <Settings2 />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
          onClick={onToggleTheme}
          className="text-muted-foreground"
        >
          {theme === 'light' ? <Moon /> : <Sun />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={tr("关于与诊断")}
          className="text-muted-foreground"
          title={tr("版本、更新与诊断包")}
          onClick={onOpenAbout}
        >
          <CircleHelp />
        </Button>
      </div>
    </header>
  )
}

/* ------------------------------------------------------------------------- */
/* Level meter                                                               */
/* ------------------------------------------------------------------------- */

function LevelMeter({ rms, active }: { rms: number; active: boolean }) {
  const bars = 20
  const lit = active ? Math.round(Math.min(1, rms * 1.9) * bars) : 0

  return (
    <div
      className="flex h-5 items-end gap-[3px]"
      aria-hidden
      title={active ? `Input level ${Math.round(rms * 100)}%` : 'Input idle'}
    >
      {Array.from({ length: bars }).map((_, index) => {
        const shape =
          0.32 + Math.sin((index / (bars - 1)) * Math.PI) * 0.68
        const on = index < lit
        return (
          <span
            key={index}
            className={cn(
              'w-[3px] rounded-full transition-[background-color] duration-150',
              on
                ? index >= bars - 4
                  ? 'bg-warning'
                  : 'bg-accent-foreground'
                : 'bg-border',
            )}
            style={{ height: `${Math.round(shape * 100)}%` }}
          />
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------------- */
/* Control dock                                                              */
/* ------------------------------------------------------------------------- */

function formatClock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

const SHORTCUT_LABEL =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
    ? '⌘ M'
    : 'Ctrl M'

type ControlDockProps = {
  state: EngineState
  source: string | null
  sampleRate: number | null
  level: { rms: number; peak: number }
  elapsedMs: number
  message: string | null
  error: string | null
  asrReady: boolean
  translateEnabled: boolean
  translateLabel: string
  onStart: () => void
  onStop: () => void
  onPause: () => void
  onResume: () => void
  onOpenSettings: () => void
}

export function ControlDock({
  state,
  source,
  sampleRate,
  level,
  elapsedMs,
  message,
  error,
  asrReady,
  translateEnabled,
  translateLabel,
  onStart,
  onStop,
  onPause,
  onResume,
  onOpenSettings,
}: ControlDockProps) {
  const active =
    state === 'listening' || state === 'starting' || state === 'paused'
  const detail = error ?? message

  return (
    <footer className="shrink-0 border-t border-border bg-card/50">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        {active ? (
          <>
            <Button
              variant="destructive-outline"
              size="lg"
              onClick={onStop}
              className="min-w-[7.5rem]"
            >
              <Square className="fill-current" />
              Stop
            </Button>
            {state === 'listening' && (
              <Button
                variant="outline"
                size="lg"
                onClick={onPause}
                title={tr("暂停采集：字幕与会话保留")}
              >
                <Pause className="fill-current" />
                {tr("暂停")}
              </Button>
            )}
            {state === 'paused' && (
              <Button size="lg" onClick={onResume} title={tr("继续采集")}>
                <Play className="fill-current" />
                {tr("继续")}
              </Button>
            )}
          </>
        ) : (
          <Button size="lg" onClick={onStart} className="min-w-[7.5rem]">
            <Play className="fill-current" />
            {asrReady ? 'Listen' : 'Set up model'}
          </Button>
        )}

        <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-2.5">
          <MonitorSpeaker className="size-4 text-muted-foreground" />
          <span className="text-sm text-foreground">
            {source ?? tr("系统声音")}
          </span>
          <span className="text-xs text-muted-foreground">
            {sampleRate ? `${Math.round(sampleRate / 1000)} kHz` : '16 kHz'}
          </span>
        </div>

        <div className="mx-1 flex items-center gap-3">
          <LevelMeter rms={level.rms} active={state === 'listening'} />
          <span className="tnum font-mono text-sm text-muted-foreground">
            {formatClock(elapsedMs)}
          </span>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenSettings}
            className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title="Translation settings"
          >
            <Badge
              variant={translateEnabled ? 'outline' : 'secondary'}
              size="sm"
              className="cursor-pointer"
            >
              <Languages />
              {translateEnabled ? translateLabel : tr("翻译关闭")}
            </Badge>
          </button>
          <Badge variant="outline" size="sm" className="hidden sm:inline-flex">
            <AudioWaveform />
            sherpa-onnx · zh/en
          </Badge>
          <Kbd className="hidden md:inline-flex">{SHORTCUT_LABEL}</Kbd>
        </div>
      </div>

      {detail && (
        <p
          className={cn(
            'border-t border-border/70 px-4 py-2 text-xs',
            error ? 'text-destructive-foreground' : 'text-muted-foreground',
          )}
        >
          {detail}
        </p>
      )}
    </footer>
  )
}

/* ------------------------------------------------------------------------- */
/* Ask panel                                                                 */
/* ------------------------------------------------------------------------- */

function pipelineFor(
  translateEnabled: boolean,
  translateLabel: string,
  asrReady: boolean,
  speechKind: 'streaming' | 'whisper' | null,
) {
  const speechValue = !asrReady
    ? 'No model selected'
    : speechKind === 'whisper'
      ? tr("Whisper 整段")
      : speechKind === 'streaming'
        ? 'Zipformer streaming'
        : 'On-device speech'
  return [
    {
      label: 'Capture',
      value: 'WASAPI loopback',
      note: '16 kHz mono',
      ready: true,
    },
    {
      label: 'Speech',
      value: speechValue,
      note: asrReady ? 'on-device' : 'download in settings',
      ready: asrReady,
    },
    {
      label: 'Translation',
      value: translateEnabled ? translateLabel : 'Off',
      note: 'sentence-level',
      ready: translateEnabled,
    },
    {
      label: 'Q&A',
      value: 'Not configured',
      note: 'transcript-grounded',
      ready: false,
    },
  ]
}

export function AskPanel({
  hasTranscript,
  asrReady,
  speechKind,
  translateEnabled,
  translateLabel,
}: {
  hasTranscript: boolean
  asrReady: boolean
  speechKind: 'streaming' | 'whisper' | null
  translateEnabled: boolean
  translateLabel: string
}) {
  const pipeline = pipelineFor(
    translateEnabled,
    translateLabel,
    asrReady,
    speechKind,
  )
  return (
    <aside className="hidden w-[21rem] shrink-0 flex-col border-l border-border bg-sidebar/50 lg:flex">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
        <h2 className="text-sm font-medium text-foreground">Ask this session</h2>
        <Badge variant="secondary" size="sm">
          v0.2
        </Badge>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <p className="text-[13px] leading-6 text-muted-foreground">
          Questions run against the transcript on this machine. Every answer
          points back to the lines it used, so you can check it against what was
          actually said.
        </p>

        <div className="mt-4 space-y-2">
          {[
            'Summarize the last ten minutes.',
            'What did they say about the homework?',
            'Define the term used at 12:40.',
          ].map((example) => (
            <div
              key={example}
              className="rounded-lg border border-border/80 bg-background px-3 py-2 text-[13px] text-muted-foreground/80"
            >
              {example}
            </div>
          ))}
        </div>

        <Separator className="my-5" />

        <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          Pipeline
        </h3>
        <ul className="mt-3 space-y-2.5">
          {pipeline.map((row) => (
            <li key={row.label} className="flex items-start gap-2.5">
              <span
                aria-hidden
                className={cn(
                  'mt-1.5 size-1.5 shrink-0 rounded-full',
                  row.ready ? 'bg-success' : 'bg-muted-foreground/35',
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[13px] text-foreground">{row.label}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {row.note}
                  </span>
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {row.value}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="shrink-0 border-t border-border p-3">
        <div className="rounded-xl border border-border bg-background p-2.5 shadow-xs/5">
          <Textarea
            disabled
            rows={2}
            placeholder={
              hasTranscript
                ? 'Ask about what was said…'
                : 'Start listening to ask about the session…'
            }
            className="min-h-0 resize-none border-0 bg-transparent p-1 shadow-none focus-visible:ring-0"
          />
          <div className="mt-1 flex items-center justify-between">
            <span className="pl-1 text-[11px] text-muted-foreground">
              Nothing is sent off this machine
            </span>
            <Button size="icon-sm" disabled aria-label="Send question">
              <ArrowUp />
            </Button>
          </div>
        </div>
      </div>
    </aside>
  )
}
