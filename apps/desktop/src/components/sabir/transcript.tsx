import { tr } from '@/lib/i18n'
import { useEffect, useRef, useState } from 'react'
import {
  AudioLines,
  Copy,
  Download,
  Eraser,
  Minus,
  Pause,
  Play,
  Plus,
  RotateCcw,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  EXPORT_LABELS,
  exportSession,
  type ExportFormat,
} from '@/lib/session'
import { routeLabel } from '@/lib/translation'
import { cn } from '@/lib/utils'
import type {
  InterimSegment,
  SegmentTranslation,
  TranscriptSegment,
} from '@/hooks/use-engine'

function formatClock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

const MIN_CAPTION = 13
const MAX_CAPTION = 24

function initialCaptionSize() {
  if (typeof window === 'undefined') return 15
  const stored = Number(window.localStorage.getItem('sabir-caption-size'))
  return Number.isFinite(stored) && stored >= MIN_CAPTION && stored <= MAX_CAPTION
    ? stored
    : 15
}

type TranscriptViewProps = {
  finals: TranscriptSegment[]
  interim: InterimSegment | null
  translations: Record<number, SegmentTranslation>
  state: 'idle' | 'starting' | 'listening' | 'paused' | 'error'
  onStart: () => void
  onClear: () => void
  onRetry: (id: number) => void
  scenePresets?: { id: string; name: string }[]
  activeSceneId?: string
  onSelectScene?: (id: string) => void
  onManageScenes?: () => void
}

export function TranscriptView({
  finals,
  interim,
  translations,
  state,
  onStart,
  onClear,
  onRetry,
  scenePresets,
  activeSceneId,
  onSelectScene,
  onManageScenes,
}: TranscriptViewProps) {
  const endRef = useRef<HTMLDivElement>(null)
  const [captionSize, setCaptionSize] = useState(initialCaptionSize)
  const [exportNote, setExportNote] = useState<string | null>(null)
  const count = finals.length + (interim ? 1 : 0)

  function changeCaptionSize(delta: number) {
    setCaptionSize((current) => {
      const next = Math.min(MAX_CAPTION, Math.max(MIN_CAPTION, current + delta))
      window.localStorage.setItem('sabir-caption-size', String(next))
      return next
    })
  }

  async function exportAs(format: ExportFormat) {
    try {
      const path = await exportSession(format)
      setExportNote(path ? `已导出：${path}` : tr("浏览器预览里不写文件"))
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setExportNote(tr('导出失败：{message}', { message }))
    }
    window.setTimeout(() => setExportNote(null), 8000)
  }

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [finals.length, interim?.id, interim?.text])

  async function copySegment(segment: TranscriptSegment) {
    const translation = translations[segment.id]
    const translated =
      translation?.status === 'done' && translation.text
        ? `\n${translation.text}`
        : ''
    try {
      await navigator.clipboard.writeText(
        `[${formatClock(segment.startMs)}] ${segment.text}${translated}`,
      )
    } catch {
      /* clipboard unavailable in some webviews; nothing to do */
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Transcript">
      <header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border px-5">
        <div className="flex items-baseline gap-2.5">
          <h2 className="text-sm font-medium text-foreground">Transcript</h2>
          <span className="tnum text-xs text-muted-foreground">
            {count === 0 ? 'empty' : `${count} ${count === 1 ? 'line' : 'lines'}`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {exportNote && (
            <span
              className="max-w-[22rem] truncate text-[11px] text-muted-foreground"
              title={exportNote}
            >
              {exportNote}
            </span>
          )}
          {state === 'listening' && (
            <Badge variant="success" size="sm">
              <span className="relative flex size-1.5">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
                <span className="relative inline-flex size-1.5 rounded-full bg-success" />
              </span>
              Live
            </Badge>
          )}
          {state === 'paused' && (
            <Badge variant="warning" size="sm">
              <Pause className="size-3" />
              {tr("已暂停")}
            </Badge>
          )}
          <div className="flex items-center rounded-lg border border-border/70 bg-background">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={tr("缩小字幕")}
              disabled={captionSize <= MIN_CAPTION}
              onClick={() => changeCaptionSize(-1)}
              className="text-muted-foreground"
            >
              <Minus />
            </Button>
            <span className="tnum px-1 text-[11px] text-muted-foreground">
              {captionSize}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={tr("放大字幕")}
              disabled={captionSize >= MAX_CAPTION}
              onClick={() => changeCaptionSize(1)}
              className="text-muted-foreground"
            >
              <Plus />
            </Button>
          </div>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={count === 0}
                  className="text-muted-foreground"
                  title={tr('导出这场会话到你的导出目录')}
                >
                  <Download />
                  {tr("导出")}
                </Button>
              }
            />
            <MenuPopup align="end" className="min-w-40">
              {(Object.keys(EXPORT_LABELS) as ExportFormat[]).map((format) => (
                <MenuItem key={format} onClick={() => void exportAs(format)}>
                  {EXPORT_LABELS[format]}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
          <Button
            variant="ghost"
            size="xs"
            onClick={onClear}
            disabled={count === 0}
            className="text-muted-foreground"
          >
            <Eraser />
            Clear
          </Button>
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        {count === 0 ? (
          <Empty className="h-full">
            <EmptyMedia variant="icon" className="size-14 [&_svg]:size-6">
              <AudioLines />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>{tr("准备好就开始")}</EmptyTitle>
              <EmptyDescription>
                {tr("选好音源，点「开始录音」。识别与翻译都在本机完成，音频不会离开这台电脑。")}
              </EmptyDescription>
            </EmptyHeader>
            {scenePresets && scenePresets.length > 0 ? (
              <div className="flex flex-wrap items-center justify-center gap-2">
                <span className="text-sm text-muted-foreground">{tr("场景背景")}</span>
                <Select
                  value={activeSceneId ?? scenePresets[0]?.id}
                  onValueChange={(value: string | null) => {
                    if (value) onSelectScene?.(value)
                  }}
                  items={scenePresets.map((preset) => ({
                    value: preset.id,
                    label: preset.name,
                  }))}
                >
                  <SelectTrigger className="w-52">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {scenePresets.map((preset) => (
                      <SelectItem key={preset.id} value={preset.id}>
                        {preset.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                {onManageScenes ? (
                  <Button variant="outline" size="sm" onClick={onManageScenes}>
                    {tr("管理…")}
                  </Button>
                ) : null}
              </div>
            ) : null}
            <Button size="lg" onClick={onStart} className="mt-1">
              <Play />
              {tr("开始录音")}
            </Button>
          </Empty>
        ) : (
          <ScrollArea className="h-full" scrollFade scrollbarGutter>
            <div className="mx-auto flex w-full max-w-3xl flex-col px-6 pb-10 pt-2">
              {finals.map((segment) => {
                const translation = translations[segment.id]
                const translated =
                  translation?.status === 'done' && translation.text.length > 0
                return (
                  <article
                    key={segment.id}
                    className="group relative grid grid-cols-[3.5rem_1fr] gap-4 border-b border-border/70 py-4 last:border-b-0"
                  >
                    <time className="tnum pt-1 font-mono text-[11px] text-muted-foreground">
                      {formatClock(segment.startMs)}
                    </time>
                    <div className="min-w-0">
                      <p
                        className={cn(
                          'caption-text',
                          translated ? 'text-foreground/70' : 'text-foreground/90',
                        )}
                        style={{ fontSize: captionSize, lineHeight: 1.65 }}
                      >
                        {segment.text}
                      </p>

                      {translation && translation.status !== 'skipped' && (
                        <div className="mt-1.5">
                          {translation.status === 'pending' && (
                            <div className="flex items-center gap-2.5 py-0.5">
                              <Skeleton className="h-3.5 w-44" />
                              <span className="text-[11px] text-muted-foreground">
                                translating…
                              </span>
                            </div>
                          )}
                          {(translation.status === 'streaming' ||
                            translation.status === 'done') && (
                            <p
                              className={cn(
                                'caption-text',
                                translation.status === 'done'
                                  ? 'text-foreground'
                                  : 'text-foreground/85',
                              )}
                              style={{ fontSize: captionSize, lineHeight: 1.65 }}
                              aria-live="polite"
                            >
                              {translation.text}
                              {translation.status === 'streaming' && (
                                <span className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] animate-caret-blink bg-accent-foreground" />
                              )}
                            </p>
                          )}
                          {translation.status === 'error' && (
                            <div className="flex flex-wrap items-center gap-2 py-0.5">
                              <span className="text-xs text-destructive-foreground">
                                {translation.message || tr("翻译失败")}
                              </span>
                              <Button
                                variant="ghost"
                                size="xs"
                                onClick={() => onRetry(segment.id)}
                                className="text-muted-foreground"
                              >
                                <RotateCcw />
                                {tr("重试")}
                              </Button>
                            </div>
                          )}
                        </div>
                      )}

                      <div className="mt-2 flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        <Badge variant="outline" size="sm">
                          ASR · local
                        </Badge>
                        {translation?.status === 'done' && (
                          <>
                            <Badge variant="secondary" size="sm">
                              {routeLabel(translation.route)}
                              {translation.provider
                                ? ` · ${translation.provider}`
                                : ''}
                            </Badge>
                            {translation.ms !== undefined && (
                              <span className="tnum text-[11px] text-muted-foreground">
                                {(translation.ms / 1000).toFixed(1)}s
                              </span>
                            )}
                            {translation.fallback && (
                              <Badge variant="warning" size="sm">
                                {tr("已回退本地")}
                              </Badge>
                            )}
                          </>
                        )}
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label="Copy line"
                          onClick={() => void copySegment(segment)}
                          className="text-muted-foreground"
                        >
                          <Copy />
                        </Button>
                      </div>
                    </div>
                  </article>
                )
              })}

              {interim && (
                <article className="relative grid grid-cols-[3.5rem_1fr] gap-4 py-4">
                  <span
                    aria-hidden
                    className="absolute inset-y-3 left-0 w-0.5 rounded-full bg-accent-foreground/70"
                  />
                  <time className="tnum pt-1 font-mono text-[11px] text-accent-foreground">
                    {formatClock(interim.startMs)}
                  </time>
                  <div className="min-w-0">
                    <p
                      className={cn('caption-text text-foreground')}
                      style={{ fontSize: captionSize, lineHeight: 1.65 }}
                      aria-live="polite"
                    >
                      {interim.text}
                      <span className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] animate-caret-blink bg-accent-foreground" />
                    </p>
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      decoding…
                    </p>
                  </div>
                </article>
              )}
              <div ref={endRef} className="h-px w-full" />
            </div>
          </ScrollArea>
        )}
      </div>
    </section>
  )
}
