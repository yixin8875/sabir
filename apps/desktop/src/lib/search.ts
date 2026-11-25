import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './engine'

/**
 * Full-text search over every local session. Rust keeps an FTS5 trigram index
 * next to the transcript table, so Chinese fragments and English words both
 * match without leaving the machine.
 */

export type SearchHit = {
  sessionId: number
  title: string
  startedAt: string
  seq: number
  startMs: number
  original: string
  translated: string | null
  score: number
  snippet: string
}

const DEMO_HITS: SearchHit[] = [
  {
    sessionId: 2,
    title: '2026-11-25 13:43',
    startedAt: '2026-11-25 13:43:47',
    seq: 1,
    startMs: 6248,
    original: 'resuming the session after a pause keeps writing to the database.',
    translated: '暂停后继续听写会接着写入数据库。',
    score: -0.5,
    snippet: '暂停后继续听写会接着写入数据库。',
  },
  {
    sessionId: 2,
    title: '2026-11-25 13:43',
    startedAt: '2026-11-25 13:43:47',
    seq: 2,
    startMs: 17228,
    original: '15 minutes in, five minutes left.',
    translated: '已经过去 15 分钟，还剩 5 分钟。',
    score: -0.6,
    snippet: '已经过去 15 分钟，还剩 5 分钟。',
  },
  {
    sessionId: 1,
    title: '2026-11-25 13:31',
    startedAt: '2026-11-25 13:31:50',
    seq: 4,
    startMs: 48200,
    original: 'The Kubernetes rollout starts Monday.',
    translated: 'Kubernetes 灰度发布周一上线。',
    score: -0.7,
    snippet: 'Kubernetes 灰度发布周一上线。',
  },
]

export async function searchLibrary(
  query: string,
  limit = 40,
  sessionId?: number,
): Promise<SearchHit[]> {
  const needle = query.trim()
  if (!needle) return []
  if (!isTauri()) {
    const lower = needle.toLowerCase()
    return DEMO_HITS.filter((hit) => {
      if (sessionId !== undefined && hit.sessionId !== sessionId) return false
      return [hit.original, hit.translated ?? '', hit.title]
        .join(' ')
        .toLowerCase()
        .includes(lower)
    }).slice(0, limit)
  }
  return invoke<SearchHit[]>('search_library', {
    query: needle,
    limit,
    sessionId: sessionId ?? null,
  })
}
