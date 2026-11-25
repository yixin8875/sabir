import { localize, tr } from '@/lib/i18n'
import { useEffect, useRef, useState } from 'react'
import {
  Download,
  FileText,
  MessagesSquare,
  Pencil,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu'
import {
  deleteSession,
  exportSession,
  listSessions,
  loadSession,
  renameSession,
  EXPORT_LABELS,
  type ExportFormat,
  type SessionDetail,
  type SessionMeta,
} from '@/lib/session'
import { cn } from '@/lib/utils'
import { CrossSessionAsk } from './cross-session-ask'
import { LibrarySearch } from './library-search'

function clock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(
    total % 60,
  ).padStart(2, '0')}`
}

function duration(meta: SessionMeta, detail: SessionDetail | null) {
  const last = detail?.segments.at(-1)?.endMs
  if (last === undefined) return tr('{n} 行', { n: meta.segments })
  const seconds = Math.floor(last / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

type LibraryDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function LibraryDialog({ open, onOpenChange }: LibraryDialogProps) {
  const [query, setQuery] = useState('')
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [mode, setMode] = useState<'detail' | 'ask' | 'search'>('detail')
  const [focusSeq, setFocusSeq] = useState<number | null>(null)
  const skipTitleBlur = useRef(false)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelected(null)
    setDetail(null)
    setNote(null)
    setConfirming(false)
    setError(null)
    setEditingTitle(false)
    setMode('detail')
    setFocusSeq(null)
    void refresh('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => void refresh(query), 220)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open])

  useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onOpenChange(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onOpenChange])

  async function refresh(needle: string) {
    setLoading(true)
    try {
      const rows = await listSessions(needle)
      setSessions(rows)
      setSelected((current) => {
        if (current && rows.some((row) => row.id === current)) return current
        const first = rows[0]
        if (first) void choose(first.id)
        else setDetail(null)
        return first ? first.id : null
      })
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  async function choose(sessionId: number) {
    setMode('detail')
    setSelected(sessionId)
    setDetail(null)
    setConfirming(false)
    setEditingTitle(false)
    try {
      setDetail(await loadSession(sessionId))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  useEffect(() => {
    if (focusSeq === null || !detail || detail.meta.id !== selected) return
    const target = document.getElementById(`segment-${focusSeq}`)
    if (!target) return
    target.scrollIntoView({ block: 'center' })
    setFocusSeq(null)
  }, [detail, focusSeq, selected])

  async function commitTitle() {
    if (!detail) return
    const next = titleDraft.trim()
    if (!next) {
      setError(tr('标题不能为空'))
      return
    }
    if (next === detail.meta.title) {
      setEditingTitle(false)
      return
    }
    try {
      const meta = await renameSession(detail.meta.id, next)
      setDetail({ ...detail, meta })
      setSessions((rows) =>
        rows.map((row) => (row.id === meta.id ? { ...row, title: meta.title } : row)),
      )
      setError(null)
      setEditingTitle(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function exportAs(format: ExportFormat) {
    if (selected === null) return
    try {
      const path = await exportSession(format, selected)
      setNote(path ? tr('已导出：{path}', { path }) : tr("浏览器预览里不写文件"))
    } catch (cause) {
      setNote(
        tr('导出失败：{message}', {
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      )
    }
    window.setTimeout(() => setNote(null), 6000)
  }

  async function remove() {
    if (selected === null) return
    try {
      await deleteSession(selected)
      setNote(tr("已删除这场会话"))
      setSelected(null)
      setDetail(null)
      setConfirming(false)
      await refresh(query)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
    window.setTimeout(() => setNote(null), 6000)
  }

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={tr("会话库")}
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/35 backdrop-blur-[2px] sm:p-6"
    >
      <div className="flex w-full max-w-5xl flex-col overflow-hidden border border-border bg-background shadow-2xl sm:rounded-xl">
        <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
          <div className="flex items-baseline gap-2.5">
            <h2 className="text-sm font-medium text-foreground">{tr("会话库")}</h2>
            <span className="text-[11px] text-muted-foreground">
              {loading
                ? tr("读取中…")
                : tr('{n} 场（本机 SQLite）', { n: sessions.length })}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {note && (
              <span
                className="max-w-[24rem] truncate text-[11px] text-muted-foreground"
                title={note}
              >
                {note}
              </span>
            )}
            <Button
              variant={mode === 'ask' ? 'secondary' : 'ghost'}
              size="xs"
              aria-pressed={mode === 'ask'}
              onClick={() =>
                setMode((current) => (current === 'ask' ? 'detail' : 'ask'))
              }
            >
              <MessagesSquare />
              {mode === 'ask' ? tr("返回会话") : tr("跨场次问答")}
            </Button>
            <Button
              variant={mode === 'search' ? 'secondary' : 'ghost'}
              size="xs"
              aria-pressed={mode === 'search'}
              onClick={() =>
                setMode((current) =>
                  current === 'search' ? 'detail' : 'search',
                )
              }
            >
              <Search />
              {mode === 'search' ? tr("返回会话") : tr("全文检索")}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={tr("关闭")}
              onClick={() => onOpenChange(false)}
              className="text-muted-foreground"
            >
              <X />
            </Button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-muted/20">
            <div className="relative border-b border-border p-2.5">
              <Search className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={tr("搜索标题、音源或字幕…")}
                className="h-8 pl-8 text-[13px]"
                aria-label={tr("搜索会话")}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {sessions.length === 0 ? (
                <p className="px-2 py-6 text-center text-[12px] leading-5 text-muted-foreground">
                  {loading
                    ? tr("读取中…")
                    : query.trim()
                      ? tr("没有匹配的会话。")
                      : tr("还没有会话。听一段后会自动写入这里。")}
                </p>
              ) : (
                sessions.map((session) => {
                  const active = session.id === selected
                  return (
                    <button
                      key={session.id}
                      type="button"
                      onClick={() => void choose(session.id)}
                      aria-current={active ? 'true' : undefined}
                      className={cn(
                        'mb-0.5 flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                        active
                          ? 'bg-accent text-accent-foreground'
                          : 'hover:bg-accent/40',
                      )}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-[13px] font-medium">
                          {session.title}
                        </span>
                        <span className="tnum shrink-0 text-[11px] text-muted-foreground">
                          {session.segments}
                        </span>
                      </span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {localize(session.source)} · {session.asrModel}
                        {session.endedAt ? '' : tr(" · 进行中")}
                      </span>
                    </button>
                  )
                })
              )}
            </div>
          </aside>

          <section className="flex min-w-0 flex-1 flex-col">
            {mode === 'ask' ? (
              <CrossSessionAsk
                onOpenSession={(sessionId, seq) => {
                  setFocusSeq(seq)
                  void choose(sessionId)
                }}
              />
            ) : mode === 'search' ? (
              <LibrarySearch
                onOpenSession={(sessionId, seq) => {
                  setFocusSeq(seq)
                  void choose(sessionId)
                }}
              />
            ) : (
              <>
                {error && (
                  <p className="border-b border-border px-4 py-2 text-[12px] text-destructive-foreground">
                    {error}
                  </p>
                )}
                {!detail ? (
              <div className="flex flex-1 items-center justify-center">
                <p className="text-[13px] text-muted-foreground">
                  {selected === null ? tr("在左侧选一场会话。") : tr("读取中…")}
                </p>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                    {editingTitle ? (
                      <Input
                        autoFocus
                        value={titleDraft}
                        maxLength={80}
                        onChange={(event) => setTitleDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            void commitTitle()
                          } else if (event.key === 'Escape') {
                            event.stopPropagation()
                            skipTitleBlur.current = true
                            setEditingTitle(false)
                          }
                        }}
                        onBlur={() => {
                          if (skipTitleBlur.current) {
                            skipTitleBlur.current = false
                            return
                          }
                          void commitTitle()
                        }}
                        className="h-7 max-w-md text-[13px]"
                        aria-label={tr("会话标题")}
                      />
                    ) : (
                      <>
                        <p className="truncate text-[13px] font-medium text-foreground">
                          {detail.meta.title}
                        </p>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={tr("重命名")}
                          className="shrink-0 text-muted-foreground"
                          onClick={() => {
                            setTitleDraft(detail.meta.title)
                            setEditingTitle(true)
                          }}
                        >
                          <Pencil />
                        </Button>
                      </>
                    )}
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {detail.meta.startedAt.slice(0, 16)} ·{' '}
                      {duration(detail.meta, detail)} ·{' '}
                      {localize(detail.meta.source)} · {detail.meta.asrModel} ·{' '}
                      {localize(detail.meta.translateRoute)}
                    </p>
                  </div>
                  <Badge variant="outline" size="sm">
                    {tr('{n} 行', { n: detail.segments.length })}
                  </Badge>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                  {detail.segments.length === 0 ? (
                    <p className="py-8 text-center text-[13px] text-muted-foreground">
                      {tr("这场会话没有字幕。")}
                    </p>
                  ) : (
                    <div className="mx-auto w-full max-w-3xl space-y-4">
                      {detail.segments.map((segment) => (
                        <article
                          key={segment.seq}
                          id={`segment-${segment.seq}`}
                          className="grid grid-cols-[3.5rem_1fr] gap-4 border-b border-border/60 pb-4 last:border-b-0"
                        >
                          <time className="tnum pt-0.5 font-mono text-[11px] text-muted-foreground">
                            {clock(segment.startMs)}
                          </time>
                          <div className="min-w-0">
                            <p className="text-[13.5px] leading-6 text-foreground/90">
                              {segment.original}
                            </p>
                            {segment.translated && (
                              <p className="mt-1 text-[13.5px] leading-6 text-foreground">
                                {segment.translated}
                              </p>
                            )}
                            {segment.error && (
                              <p className="mt-1 text-[11px] text-destructive-foreground">
                                {tr('翻译失败：{error}', { error: segment.error })}
                              </p>
                            )}
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                </div>

                <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-4 py-2.5">
                  <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <FileText className="size-3.5" />
                    {tr('导出到你的导出目录')}
                  </span>
                  <div className="flex items-center gap-2">
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="xs"
                            className="text-muted-foreground"
                          >
                            <Download />
                            {tr("导出")}
                          </Button>
                        }
                      />
                      <MenuPopup align="end" className="min-w-40">
                        {(Object.keys(EXPORT_LABELS) as ExportFormat[]).map(
                          (format) => (
                            <MenuItem
                              key={format}
                              onClick={() => void exportAs(format)}
                            >
                              {EXPORT_LABELS[format]}
                            </MenuItem>
                          ),
                        )}
                      </MenuPopup>
                    </Menu>
                    {confirming ? (
                      <>
                        <Button
                          variant="destructive"
                          size="xs"
                          onClick={() => void remove()}
                        >
                          {tr("确认删除")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => setConfirming(false)}
                          className="text-muted-foreground"
                        >
                          {tr("取消")}
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => setConfirming(true)}
                        className="text-muted-foreground"
                      >
                        <Trash2 />
                        {tr("删除")}
                      </Button>
                    )}
                  </div>
                </footer>
              </>
            )}
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
