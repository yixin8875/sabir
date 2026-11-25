import { tr } from '@/lib/i18n'
import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Quote, Search, Square } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  askAcrossSessions,
  searchAcrossSessions,
  type AskResult,
  type CrossLine,
} from '@/lib/ask'

type Message = {
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
  route?: string
  provider?: string | null
  ms?: number
  citations?: number[]
  evidence?: CrossLine[]
  sessions?: number
  error?: string
  searchOnly?: boolean
}

const EXAMPLES = [
  tr('上次的评审最后定了什么？'),
  tr('Kubernetes 发布安排在什么时候？'),
  tr('把最近几场会话里的待办列出来。'),
]

function clock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(
    total % 60,
  ).padStart(2, '0')}`
}

type CrossSessionAskProps = {
  onOpenSession: (sessionId: number, seq: number) => void
}

export function CrossSessionAsk({ onOpenSession }: CrossSessionAskProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const running = useRef<AskResult | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [messages])

  function updateLast(change: Partial<Message>) {
    setMessages((current) => {
      const next = [...current]
      const index = next.length - 1
      if (index >= 0 && next[index].role === 'assistant') {
        next[index] = { ...next[index], ...change }
      }
      return next
    })
  }

  function fail(message: string) {
    setBusy(false)
    running.current = null
    updateLast({ streaming: false, error: message })
  }

  function ask() {
    const question = input.trim()
    if (!question || busy) return
    setInput('')
    setBusy(true)
    setMessages((current) => [
      ...current,
      { role: 'user', text: question },
      { role: 'assistant', text: '', streaming: true },
    ])
    running.current = askAcrossSessions(question, (event) => {
      if (event.type === 'retrieved') {
        updateLast({ evidence: event.lines, sessions: event.sessions })
        return
      }
      if (event.type === 'delta') {
        updateLast({ text: event.text, streaming: true })
        return
      }
      if (event.type === 'done') {
        setBusy(false)
        running.current = null
        updateLast({
          streaming: false,
          route: event.route,
          provider: event.provider,
          ms: event.ms,
          citations: event.citations,
        })
        return
      }
      fail(event.message)
    })
  }

  async function search() {
    const query = input.trim()
    if (!query || busy) return
    setInput('')
    setBusy(true)
    setMessages((current) => [
      ...current,
      { role: 'user', text: query },
      {
        role: 'assistant',
        text: '',
        searchOnly: true,
        streaming: false,
      },
    ])
    try {
      const lines = await searchAcrossSessions(query)
      updateLast({
        evidence: lines,
        sessions: new Set(lines.map((line) => line.sessionId)).size,
        error: lines.length === 0 ? tr("没有检索到匹配的字幕。") : undefined,
      })
    } catch (cause) {
      updateLast({
        error: cause instanceof Error ? cause.message : String(cause),
      })
    } finally {
      setBusy(false)
    }
  }

  function stop() {
    running.current?.stop()
    running.current = null
    setBusy(false)
    setMessages((current) => {
      const next = [...current]
      const index = next.length - 1
      if (index >= 0 && next[index].streaming) {
        next[index] = {
          ...next[index],
          streaming: false,
          text: next[index].text || tr("已停止。"),
        }
      }
      return next
    })
  }

  function evidenceFor(citations: number[], evidence?: CrossLine[]) {
    return citations
      .map((index) => evidence?.find((line) => line.index === index))
      .filter((line): line is CrossLine => Boolean(line))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
        <h2 className="text-sm font-medium text-foreground">
          {tr("跨场次问答")}
        </h2>
        <Badge variant="secondary" size="sm">
          {tr("全部会话")}
        </Badge>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <div className="mx-auto max-w-2xl">
            <p className="text-[13px] leading-6 text-muted-foreground">
              {tr("在全部历史会话的字幕里检索并回答。回答会标注依据来自哪一场、哪个时间点，点开即可回看原文。")}
            </p>
            <p className="mt-2 text-[11px] leading-5 text-muted-foreground/80">
              {tr("检索在本机 SQLite 完成；只有检索到的字幕行会随问题发给「翻译与聊天」里配置的模型。")}
            </p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => setInput(example)}
                  className="rounded-lg border border-border/80 bg-background px-3 py-2 text-left text-[13px] text-muted-foreground/80 transition-colors hover:bg-muted/50 hover:text-foreground"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-2xl space-y-4">
            {messages.map((message, index) =>
              message.role === 'user' ? (
                <div key={index} className="flex justify-end">
                  <p className="max-w-[90%] rounded-xl rounded-br-sm bg-primary px-3 py-2 text-[13px] leading-6 text-primary-foreground">
                    {message.text}
                  </p>
                </div>
              ) : (
                <div
                  key={index}
                  className="rounded-xl border border-border bg-background p-3"
                >
                  {message.searchOnly ? (
                    message.error ? (
                      <p className="text-[13px] leading-6 text-destructive-foreground">
                        {message.error}
                      </p>
                    ) : (
                      <p className="text-[13px] text-muted-foreground">
                        {tr('检索到 {n} 行，来自 {sessions} 场会话。', {
                          n: message.evidence?.length ?? 0,
                          sessions: message.sessions ?? 0,
                        })}
                      </p>
                    )
                  ) : (
                    <>
                      {message.text ? (
                        <p className="whitespace-pre-wrap text-[13px] leading-6 text-foreground">
                          {message.text}
                        </p>
                      ) : message.error ? null : (
                        <p className="text-[13px] text-muted-foreground">
                          {tr("检索中…")}
                        </p>
                      )}
                      {message.error && (
                        <p className="text-[13px] leading-6 text-destructive-foreground">
                          {message.error}
                        </p>
                      )}
                      {message.streaming && (
                        <span className="mt-1 inline-block h-[1em] w-[2px] animate-caret-blink bg-accent-foreground align-middle" />
                      )}
                      {message.citations && message.citations.length > 0 && (
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <Quote className="size-3 text-muted-foreground" />
                          {evidenceFor(message.citations, message.evidence)
                            .slice(0, 8)
                            .map((line) => (
                              <button
                                key={line.index}
                                type="button"
                                onClick={() =>
                                  onOpenSession(line.sessionId, line.seq)
                                }
                                className="rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                                title={line.original}
                              >
                                {line.title} · {clock(line.startMs)}
                              </button>
                            ))}
                        </div>
                      )}
                      {message.route && !message.streaming && (
                        <p className="mt-2 text-[11px] text-muted-foreground">
                          {message.route === 'localLlm'
                            ? tr("本地 LLM")
                            : message.route === 'remoteLlm'
                              ? tr("第三方")
                              : message.route}
                          {message.provider ? ` · ${message.provider}` : ''}
                          {message.ms !== undefined
                            ? ` · ${(message.ms / 1000).toFixed(1)}s`
                            : ''}
                        </p>
                      )}
                    </>
                  )}

                  {message.evidence && message.evidence.length > 0 && (
                    <div className="mt-3 border-t border-border/70 pt-2.5">
                      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                        {tr('检索依据 · {n} 行 · {sessions} 场', {
                          n: message.evidence.length,
                          sessions: message.sessions ?? 0,
                        })}
                      </p>
                      <div className="mt-2 max-h-56 space-y-1 overflow-y-auto pr-1">
                        {message.evidence.map((line) => (
                          <button
                            key={`${line.sessionId}-${line.seq}`}
                            type="button"
                            onClick={() =>
                              onOpenSession(line.sessionId, line.seq)
                            }
                            className="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-muted/60"
                          >
                            <span className="tnum shrink-0 font-mono text-[10px] text-muted-foreground">
                              {clock(line.startMs)}
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate text-[10px] text-muted-foreground">
                                {line.title}
                              </span>
                              <span className="block truncate text-[12px] text-foreground/85">
                                {line.original}
                              </span>
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ),
            )}
            <div ref={endRef} className="h-px w-full" />
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border p-3">
        <div className="rounded-xl border border-border bg-background p-2.5 shadow-xs/5">
          <Textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                ask()
              }
            }}
            rows={2}
            placeholder={tr("就全部历史会话说点什么，或输入关键词检索…（Enter 提问）")}
            className="min-h-0 resize-none border-0 bg-transparent p-1 shadow-none focus-visible:ring-0"
          />
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="pl-1 text-[11px] text-muted-foreground">
              {tr("只发送检索到的字幕行，且仅在你配置了模型时")}
            </span>
            <div className="flex items-center gap-1.5">
              {busy ? (
                <Button
                  size="icon-sm"
                  aria-label={tr("停止回答")}
                  onClick={stop}
                >
                  <Square />
                </Button>
              ) : (
                <>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={tr("只检索")}
                    disabled={!input.trim()}
                    onClick={() => void search()}
                    className="text-muted-foreground"
                  >
                    <Search />
                  </Button>
                  <Button
                    size="icon-sm"
                    aria-label={tr("提问")}
                    disabled={!input.trim()}
                    onClick={ask}
                  >
                    <ArrowUp />
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
