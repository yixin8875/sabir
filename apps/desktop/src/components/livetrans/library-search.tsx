import { tr } from '@/lib/i18n'
import { useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { searchLibrary, type SearchHit } from '@/lib/search'

function clock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(
    total % 60,
  ).padStart(2, '0')}`
}

type LibrarySearchProps = {
  onOpenSession: (sessionId: number, seq: number) => void
}

/**
 * Full-text results across every session. Rust returns the best bm25-ranked
 * lines with a short snippet; clicking one opens the session at that line.
 */
export function LibrarySearch({ onOpenSession }: LibrarySearchProps) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const needle = query.trim()
    if (!needle) {
      setHits([])
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    const timer = window.setTimeout(() => {
      void searchLibrary(needle)
        .then((rows) => {
          if (!alive) return
          setHits(rows)
          setError(null)
        })
        .catch((cause) => {
          if (!alive) return
          setHits([])
          setError(cause instanceof Error ? cause.message : String(cause))
        })
        .finally(() => {
          if (alive) setLoading(false)
        })
    }, 220)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [query])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tr("全文检索：英文单词或至少 3 个中文字…")}
            className="h-9 pl-8 text-[13px]"
            aria-label={tr("全文检索")}
          />
        </div>
        <p className="mt-2 px-1 text-[11px] leading-4 text-muted-foreground">
          {tr(
            "在本机全部字幕里检索，按相关度排序；点击结果会打开对应会话并跳到那一句。少于 3 个字的词用普通包含匹配。",
          )}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loading ? (
          <p className="flex items-center gap-2 px-1 py-6 text-[12px] text-muted-foreground">
            <Spinner className="size-3.5" />
            {tr("检索中…")}
          </p>
        ) : error ? (
          <p className="px-1 py-6 text-[12px] leading-5 text-destructive-foreground">
            {error}
          </p>
        ) : hits.length === 0 ? (
          <p className="px-1 py-6 text-center text-[12px] leading-5 text-muted-foreground">
            {query.trim()
              ? tr("没有匹配的字幕。换个关键词，或只用其中几个词。")
              : tr("输入一个英文单词，或至少 3 个连续的中文字。")}
          </p>
        ) : (
          <div className="space-y-1.5">
            {hits.map((hit) => (
              <button
                key={`${hit.sessionId}-${hit.seq}`}
                type="button"
                onClick={() => onOpenSession(hit.sessionId, hit.seq)}
                className="w-full rounded-lg border border-border/70 px-3 py-2.5 text-left transition-colors hover:bg-accent/40"
              >
                <span className="flex items-center justify-between gap-3">
                  <span className="truncate text-[12px] font-medium text-foreground">
                    {hit.title}
                  </span>
                  <span className="tnum shrink-0 text-[11px] text-muted-foreground">
                    {clock(hit.startMs)}
                  </span>
                </span>
                <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                  {hit.original}
                </span>
                {hit.snippet && hit.snippet !== hit.original && (
                  <span className="mt-1 line-clamp-2 block text-[13px] leading-5 text-foreground">
                    {hit.snippet}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
