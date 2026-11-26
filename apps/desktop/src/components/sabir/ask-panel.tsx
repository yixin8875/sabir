import { tr } from '@/lib/i18n'
import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Quote, Square } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import { askQuestion, type AskResult } from '@/lib/ask'
import type { TranscriptSegment } from '@/hooks/use-engine'
import { cn } from '@/lib/utils'

type Message = {
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
  route?: string
  provider?: string | null
  ms?: number
  citations?: number[]
  error?: string
}

const EXAMPLES = [
  'Summarize the last ten minutes.',
  'What did they say about the homework?',
  'List the key terms with timestamps.',
]

function clock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

type AskPanelProps = {
  finals: TranscriptSegment[]
  hasTranscript: boolean
  asrReady: boolean
  speechKind: 'streaming' | 'whisper' | null
  translateEnabled: boolean
  translateLabel: string
}

export function AskPanel({
  finals,
  hasTranscript,
  asrReady,
  speechKind,
  translateEnabled,
  translateLabel,
}: AskPanelProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const running = useRef<AskResult | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  const times = new Map(finals.map((line) => [line.id, line.startMs]))

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [messages])

  function send() {
    const question = input.trim()
    if (!question || busy) return
    setInput('')
    if (!hasTranscript) {
      setMessages((current) => [
        ...current,
        { role: 'user', text: question },
        { role: 'assistant', text: '', error: tr("还没有字幕可以提问；先听一段。") },
      ])
      return
    }
    setBusy(true)
    setMessages((current) => [
      ...current,
      { role: 'user', text: question },
      { role: 'assistant', text: '', streaming: true },
    ])

    const update = (change: Partial<Message>) => {
      setMessages((current) => {
        const next = [...current]
        const index = next.length - 1
        if (index >= 0 && next[index].role === 'assistant') {
          next[index] = { ...next[index], ...change }
        }
        return next
      })
    }

    running.current = askQuestion(
      question,
      finals.map((line) => ({
        seq: line.id,
        startMs: line.startMs,
        text: line.text,
      })),
      (event) => {
        if (event.type === 'delta') {
          update({ text: event.text, streaming: true })
          return
        }
        if (event.type === 'done') {
          setBusy(false)
          running.current = null
          update({
            streaming: false,
            route: event.route,
            provider: event.provider,
            ms: event.ms,
            citations: event.citations,
          })
          return
        }
        setBusy(false)
        running.current = null
        update({ streaming: false, error: event.message })
      },
    )
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

  const pipeline = [
    { label: 'Capture', value: 'WASAPI loopback', ready: true },
    {
      label: 'Speech',
      value: !asrReady
        ? 'No model selected'
        : speechKind === 'whisper'
          ? tr("Whisper 整段")
          : speechKind === 'streaming'
            ? 'Zipformer streaming'
            : 'On-device speech',
      ready: asrReady,
    },
    {
      label: 'Translation',
      value: translateEnabled ? translateLabel : 'Off',
      ready: translateEnabled,
    },
    {
      label: 'Q&A',
      value: hasTranscript ? 'Ready' : 'Needs transcript',
      ready: hasTranscript,
    },
  ]

  return (
    <aside className="hidden w-[21rem] shrink-0 flex-col border-l border-border bg-sidebar/50 lg:flex">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
        <h2 className="text-sm font-medium text-foreground">Ask this session</h2>
        <Badge variant="secondary" size="sm">
          transcript-grounded
        </Badge>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <>
            <p className="text-[13px] leading-6 text-muted-foreground">
              Questions run against the transcript on this machine. Answers cite
              the lines they used, so you can check them against what was
              actually said.
            </p>
            <p className="mt-2 text-[11px] leading-5 text-muted-foreground/80">
              {tr("使用「翻译与聊天」里配置的本地 LLM 或第三方接口；只有字幕文本会发出。")}
            </p>
            <div className="mt-4 space-y-2">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => setInput(example)}
                  className="w-full rounded-lg border border-border/80 bg-background px-3 py-2 text-left text-[13px] text-muted-foreground/80 transition-colors hover:bg-muted/50 hover:text-foreground"
                >
                  {example}
                </button>
              ))}
            </div>

            <Separator className="my-5" />

            <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Pipeline
            </h3>
            <ul className="mt-3 space-y-2.5">
              {pipeline.map((row) => (
                <li key={row.label} className="flex items-center gap-2.5">
                  <span
                    aria-hidden
                    className={cn(
                      'size-1.5 shrink-0 rounded-full',
                      row.ready ? 'bg-success' : 'bg-muted-foreground/35',
                    )}
                  />
                  <span className="w-20 shrink-0 text-[13px] text-foreground">
                    {row.label}
                  </span>
                  <span className="truncate text-[11px] text-muted-foreground">
                    {row.value}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className="space-y-4">
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
                  {message.text ? (
                    <p className="whitespace-pre-wrap text-[13px] leading-6 text-foreground">
                      {message.text}
                    </p>
                  ) : message.error ? null : (
                    <p className="text-[13px] text-muted-foreground">thinking…</p>
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
                      {message.citations.slice(0, 8).map((seq) => (
                        <Badge key={seq} variant="outline" size="sm">
                          {times.has(seq) ? clock(times.get(seq) ?? 0) : `#${seq}`}
                        </Badge>
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
                send()
              }
            }}
            rows={2}
            placeholder={
              hasTranscript
                ? tr("Ask about what was said…（Enter 发送）")
                : 'Start listening to ask about the session…'
            }
            className="min-h-0 resize-none border-0 bg-transparent p-1 shadow-none focus-visible:ring-0"
          />
          <div className="mt-1 flex items-center justify-between">
            <span className="pl-1 text-[11px] text-muted-foreground">
              Only transcript text leaves this machine, and only if you set a provider
            </span>
            {busy ? (
              <Button size="icon-sm" aria-label="Stop answer" onClick={stop}>
                <Square />
              </Button>
            ) : (
              <Button
                size="icon-sm"
                disabled={!input.trim()}
                aria-label="Send question"
                onClick={send}
              >
                <ArrowUp />
              </Button>
            )}
          </div>
        </div>
      </div>
    </aside>
  )
}
