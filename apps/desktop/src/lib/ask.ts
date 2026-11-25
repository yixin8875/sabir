import { tr } from '@/lib/i18n'
/**
 * Ask the transcript a question.
 *
 * Rust builds the numbered context, streams the answer, and returns the line
 * numbers the answer cited. Audio never leaves the machine; text reaches the
 * configured local LLM, or the user's own provider only after consent.
 */

import { Channel, invoke } from '@tauri-apps/api/core'
import { isTauri } from './engine'

export type AskLine = {
  seq: number
  startMs: number
  text: string
}

export type AskEvent =
  | { type: 'delta'; text: string }
  | {
      type: 'done'
      route: string
      provider?: string | null
      ms: number
      citations: number[]
    }
  | { type: 'error'; code: string; message: string }

export type AskResult = {
  stop: () => void
}

export function askQuestion(
  question: string,
  lines: AskLine[],
  onEvent: (event: AskEvent) => void,
): AskResult {
  if (!isTauri()) {
    return startDemoAnswer(question, lines, onEvent)
  }

  const channel = new Channel<AskEvent>()
  channel.onmessage = onEvent
  void invoke('ask_question', { question, lines, channel }).catch((cause) => {
    onEvent({
      type: 'error',
      code: 'invoke',
      message: cause instanceof Error ? cause.message : String(cause),
    })
  })
  return {
    stop: () => {
      channel.onmessage = () => {}
    },
  }
}

/* ------------------------------------------------------------------------- */
/* Cross-session search and Q&A                                              */
/* ------------------------------------------------------------------------- */

/** One retrieved line, numbered for citation chips. */
export type CrossLine = {
  index: number
  sessionId: number
  title: string
  startedAt: string
  seq: number
  startMs: number
  original: string
  translated: string | null
}

export type CrossAskEvent =
  | { type: 'retrieved'; lines: CrossLine[]; sessions: number }
  | { type: 'delta'; text: string }
  | {
      type: 'done'
      route: string
      provider?: string | null
      ms: number
      citations: number[]
    }
  | { type: 'error'; code: string; message: string }

/**
 * Ask across every session. Rust retrieves the relevant lines, streams them
 * back as `retrieved`, then answers citing their 1-based indices.
 */
export function askAcrossSessions(
  question: string,
  onEvent: (event: CrossAskEvent) => void,
): AskResult {
  if (!isTauri()) return startDemoCrossAnswer(question, onEvent)

  const channel = new Channel<CrossAskEvent>()
  channel.onmessage = onEvent
  void invoke('ask_across_sessions', { question, channel }).catch((cause) => {
    onEvent({
      type: 'error',
      code: 'invoke',
      message: cause instanceof Error ? cause.message : String(cause),
    })
  })
  return {
    stop: () => {
      channel.onmessage = () => {}
    },
  }
}

/** Search every session's transcript without calling a model. */
export async function searchAcrossSessions(
  query: string,
): Promise<CrossLine[]> {
  if (!isTauri()) return demoRetrieve(query)
  return invoke<CrossLine[]>('search_transcripts', { query })
}

/* ------------------------------------------------------------------------- */
/* Demo answer — browser preview only                                        */
/* ------------------------------------------------------------------------- */

const DEMO_CROSS: Omit<CrossLine, 'index'>[] = [
  {
    sessionId: 2,
    title: '2026-11-25 13:43',
    startedAt: '2026-11-25 13:43:47',
    seq: 1,
    startMs: 6248,
    original: 'resuming the session after a pause keeps writing to the database.',
    translated: tr('暂停后继续听写会接着写入数据库。'),
  },
  {
    sessionId: 2,
    title: '2026-11-25 13:43',
    startedAt: '2026-11-25 13:43:47',
    seq: 2,
    startMs: 17228,
    original: '15 minutes in, five minutes left.',
    translated: tr('已经过去 15 分钟，还剩 5 分钟。'),
  },
  {
    sessionId: 1,
    title: '2026-11-25 13:31',
    startedAt: '2026-11-25 13:31:50',
    seq: 3,
    startMs: 42000,
    original: 'the Kubernetes rollout starts on Monday.',
    translated: tr('Kubernetes 灰度发布周一上线。'),
  },
  {
    sessionId: 1,
    title: '2026-11-25 13:31',
    startedAt: '2026-11-25 13:31:50',
    seq: 5,
    startMs: 96000,
    original: 'we still need to review the canary dashboard.',
    translated: tr('我们还需要检查金丝雀发布面板。'),
  },
  {
    sessionId: 1,
    title: '2026-11-25 13:31',
    startedAt: '2026-11-25 13:31:50',
    seq: 7,
    startMs: 180000,
    original: 'please send the notes to the product team.',
    translated: tr('请把笔记发给产品团队。'),
  },
]

function demoTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length >= 2)
}

function demoRetrieve(query: string): CrossLine[] {
  const terms = demoTerms(query)
  const scored = DEMO_CROSS.map((line) => {
    const haystack = `${line.original} ${line.translated ?? ''}`.toLowerCase()
    const score = terms.filter((term) => haystack.includes(term)).length
    return { line, score }
  })
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.line.sessionId - a.line.sessionId ||
        b.line.startMs - a.line.startMs,
    )
    .slice(0, 8)
  const chosen =
    scored.length > 0
      ? scored
      : DEMO_CROSS.slice(-3).map((line) => ({ line, score: 0 }))
  return chosen
    .sort(
      (a, b) =>
        b.line.sessionId - a.line.sessionId ||
        a.line.startMs - b.line.startMs,
    )
    .map((entry, index) => ({ ...entry.line, index: index + 1 }))
}

function startDemoCrossAnswer(
  question: string,
  onEvent: (event: CrossAskEvent) => void,
): AskResult {
  const lines = demoRetrieve(question)
  const sessions = new Set(lines.map((line) => line.sessionId)).size
  onEvent({ type: 'retrieved', lines, sessions })
  const cited = lines.slice(0, Math.min(2, lines.length))
  const parts = [
    tr('（浏览器预览，不会真的调用模型）'),
    tr('从历史会话里检索到 {n} 行字幕，涉及 {sessions} 场。', {
      n: lines.length,
      sessions,
    }),
  ]
  for (const line of cited) {
    parts.push(
      tr('「{title}」{time} 提到：{text}', {
        title: line.title,
        time: formatClock(line.startMs),
        text: line.original.slice(0, 60),
      }) + ` [${line.index}]`,
    )
  }
  const text = parts.join('\n\n')
  let sent = 0
  const timer = window.setInterval(() => {
    const next = Math.min(text.length, sent + 12)
    onEvent({ type: 'delta', text: text.slice(0, next) })
    sent = next
    if (sent >= text.length) {
      window.clearInterval(timer)
      onEvent({
        type: 'done',
        route: 'demo',
        provider: null,
        ms: 900,
        citations: cited.map((line) => line.index),
      })
    }
  }, 40)
  return { stop: () => window.clearInterval(timer) }
}

function startDemoAnswer(
  question: string,
  lines: AskLine[],
  onEvent: (event: AskEvent) => void,
): AskResult {
  const cited = lines.slice(-3).map((line) => line.seq)
  const last = lines.at(-1)
  const text =
    tr("（浏览器预览，不会真的调用模型）") +
    '\n\n' +
    tr('根据当前字幕，最近的内容围绕「{topic}」展开。', {
      topic: last?.text.slice(0, 40) ?? '…',
    }) +
    '\n\n' +
    tr('你问的是「{question}」，转录里提到的时间点见下方引用。', { question }) +
    '\n\n' +
    tr('1. 字幕里有 {n} 行可用上下文 [{first}]', {
      n: lines.length,
      first: cited[0] ?? 1,
    }) +
    '\n' +
    tr('2. 最后一句出现在 {time} [{last}]', {
      time: formatClock(last?.startMs ?? 0),
      last: cited.at(-1) ?? 1,
    })
  let sent = 0
  const timer = window.setInterval(() => {
    const next = Math.min(text.length, sent + 12)
    onEvent({ type: 'delta', text: text.slice(0, next) })
    sent = next
    if (sent >= text.length) {
      window.clearInterval(timer)
      onEvent({
        type: 'done',
        route: 'demo',
        provider: null,
        ms: 900,
        citations: cited,
      })
    }
  }, 40)
  return { stop: () => window.clearInterval(timer) }
}

function formatClock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}
