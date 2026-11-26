import { tr } from '@/lib/i18n'
/**
 * Local session history and export.
 *
 * Rust keeps `sabir.db` and writes exported files into the folder chosen
 * in settings (`Documents\Sabir` by default); the WebView lists sessions,
 * shows a read-only copy, renames titles and asks for an export.
 */

import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './engine'

export type ExportFormat = 'md' | 'jsonl' | 'srt'

export const EXPORT_LABELS: Record<ExportFormat, string> = {
  md: tr("Markdown 笔记"),
  jsonl: tr("JSONL 数据"),
  srt: tr("SRT 字幕"),
}

export type SessionMeta = {
  id: number
  startedAt: string
  endedAt: string | null
  title: string
  source: string
  asrModel: string
  translateRoute: string
  segments: number
}

export type SessionSegment = {
  seq: number
  startMs: number
  endMs: number
  original: string
  translated: string | null
  route: string | null
  provider: string | null
  error: string | null
}

export type SessionDetail = {
  meta: SessionMeta
  segments: SessionSegment[]
}

export async function exportSession(
  format: ExportFormat,
  sessionId?: number,
): Promise<string | null> {
  if (!isTauri()) return null
  return invoke<string>('export_session', {
    sessionId: sessionId ?? null,
    format,
  })
}

const DEMO_SESSIONS: SessionMeta[] = [
  {
    id: 2,
    startedAt: '2026-11-25 13:43:47',
    endedAt: '2026-11-25 13:46:42',
    title: '2026-11-25 13:43',
    source: tr("系统声音"),
    asrModel: 'whisper-small',
    translateRoute: 'nmt',
    segments: 3,
  },
  {
    id: 1,
    startedAt: '2026-11-25 13:31:50',
    endedAt: '2026-11-25 13:42:56',
    title: '2026-11-25 13:31',
    source: tr("系统声音"),
    asrModel: 'whisper-small',
    translateRoute: 'nmt',
    segments: 7,
  },
]

const DEMO_DETAIL: SessionDetail = {
  meta: DEMO_SESSIONS[0],
  segments: [
    {
      seq: 1,
      startMs: 6248,
      endMs: 11548,
      original: 'resuming the session after a pause keeps writing to the database.',
      translated: tr("暂停后继续听写会接着写入数据库。"),
      route: 'nmt',
      provider: null,
      error: null,
    },
    {
      seq: 2,
      startMs: 17228,
      endMs: 20288,
      original: '15 minutes in, five minutes left.',
      translated: tr("已经过去 15 分钟，还剩 5 分钟。"),
      route: 'nmt',
      provider: null,
      error: null,
    },
  ],
}

export async function listSessions(
  query = '',
  limit = 80,
): Promise<SessionMeta[]> {
  if (!isTauri()) {
    const needle = query.trim().toLowerCase()
    return needle
      ? DEMO_SESSIONS.filter((session) =>
          session.title.toLowerCase().includes(needle),
        )
      : DEMO_SESSIONS
  }
  return invoke<SessionMeta[]>('list_sessions', { query, limit })
}

export async function loadSession(
  sessionId: number,
): Promise<SessionDetail> {
  if (!isTauri()) return DEMO_DETAIL
  return invoke<SessionDetail>('session_detail', { sessionId })
}

export async function renameSession(
  sessionId: number,
  title: string,
): Promise<SessionMeta> {
  const next = title.trim()
  if (!next) throw new Error(tr('标题不能为空'))
  if (!isTauri()) {
    const target = DEMO_SESSIONS.find((session) => session.id === sessionId)
    if (!target) throw new Error(tr('找不到这场会话'))
    target.title = next
    return { ...target }
  }
  return invoke<SessionMeta>('rename_session', {
    sessionId,
    title: next,
  })
}

export async function deleteSession(sessionId: number): Promise<void> {
  if (!isTauri()) return
  await invoke('delete_session', { sessionId })
}
