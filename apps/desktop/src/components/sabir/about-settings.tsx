import { tr } from '@/lib/i18n'
import { useEffect, useState } from 'react'
import { FileArchive, PackageOpen, RefreshCw, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { exportDiagnosticsBundle } from '@/lib/diagnostics'
import { isTauri } from '@/lib/engine'
import {
  checkForAppUpdate,
  installAppUpdate,
  relaunchApp,
  updatesSupported,
  type UpdateInfo,
} from '@/lib/updater'

type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'latest' }
  | { phase: 'available'; info: UpdateInfo }
  | { phase: 'installing'; progress: number | null }
  | { phase: 'ready'; version: string }
  | { phase: 'error'; message: string }

export function AboutSettings() {
  const [version, setVersion] = useState('0.1.0')
  const [update, setUpdate] = useState<UpdateState>({ phase: 'idle' })
  const [diagBusy, setDiagBusy] = useState(false)
  const [diagNote, setDiagNote] = useState<string | null>(null)
  const [diagError, setDiagError] = useState<string | null>(null)

  useEffect(() => {
    if (!isTauri()) return
    let alive = true
    void import('@tauri-apps/api/app')
      .then(({ getVersion }) => getVersion())
      .then((value) => {
        if (alive) setVersion(value)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  async function check() {
    setUpdate({ phase: 'checking' })
    try {
      const info = await checkForAppUpdate()
      setUpdate(info ? { phase: 'available', info } : { phase: 'latest' })
    } catch (cause) {
      setUpdate({
        phase: 'error',
        message: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }

  async function install(info: UpdateInfo) {
    setUpdate({ phase: 'installing', progress: null })
    try {
      await installAppUpdate((progress) =>
        setUpdate({ phase: 'installing', progress }),
      )
      setUpdate({ phase: 'ready', version: info.version })
    } catch (cause) {
      setUpdate({
        phase: 'error',
        message: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }

  async function restart() {
    try {
      await relaunchApp()
    } catch (cause) {
      setUpdate({
        phase: 'error',
        message: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }

  async function exportBundle() {
    setDiagBusy(true)
    setDiagError(null)
    setDiagNote(null)
    try {
      const result = await exportDiagnosticsBundle()
      if (result) {
        setDiagNote(
          isTauri() ? tr('诊断包已保存：{path}', { path: result }) : result,
        )
      }
    } catch (cause) {
      setDiagError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDiagBusy(false)
    }
  }

  const busy = update.phase === 'checking' || update.phase === 'installing'
  const supported = updatesSupported()

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            {tr("软件更新")}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {tr("Sabir {version} · 本机运行，更新检查只访问发布源。", {
              version,
            })}
          </p>
        </div>

        <div className="rounded-xl border border-border bg-muted/25 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <PackageOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">
                  {tr("检查并安装更新")}
                </p>
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  {tr(
                    "安装包与 latest.json 都经过 Minisign 签名校验；下载完成后需要重启应用。",
                  )}
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void check()}
              loading={update.phase === 'checking'}
              disabled={busy || !supported}
            >
              <RefreshCw />
              {tr("检查更新")}
            </Button>
          </div>

          {!supported && (
            <p className="mt-3 text-[11px] leading-4 text-muted-foreground">
              {tr("浏览器预览不会检查更新；安装版会读取已配置的更新源。")}
            </p>
          )}

          {update.phase === 'latest' && (
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              {tr("已是最新版本（{version}）。", { version })}
            </p>
          )}

          {update.phase === 'available' && (
            <div className="mt-3 space-y-2 rounded-lg border border-border bg-background p-3">
              <p className="text-xs leading-5 text-foreground">
                {tr("发现新版本 {version}（当前 {current}）。", {
                  version: update.info.version,
                  current: update.info.currentVersion,
                })}
              </p>
              {update.info.date && (
                <p className="text-[11px] text-muted-foreground">
                  {update.info.date.slice(0, 10)}
                </p>
              )}
              {update.info.body && (
                <p className="max-h-32 overflow-y-auto whitespace-pre-line text-[11px] leading-5 text-muted-foreground">
                  {update.info.body}
                </p>
              )}
              <Button
                size="sm"
                onClick={() => void install(update.info)}
                disabled={busy}
              >
                {tr("下载并安装")}
              </Button>
            </div>
          )}

          {update.phase === 'installing' && (
            <div className="mt-3 space-y-1.5">
              <p className="text-xs text-muted-foreground">
                {update.progress === null
                  ? tr("正在下载更新…")
                  : tr("正在下载并安装：{percent}%", {
                      percent: Math.round(update.progress * 100),
                    })}
              </p>
              <div className="h-1.5 overflow-hidden rounded-full bg-border">
                <div
                  className="h-full bg-primary transition-[width]"
                  style={{
                    width: `${Math.round((update.progress ?? 0) * 100)}%`,
                  }}
                />
              </div>
            </div>
          )}

          {update.phase === 'ready' && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <p className="text-xs leading-5 text-foreground">
                {tr("版本 {version} 已安装，重启后生效。", {
                  version: update.version,
                })}
              </p>
              <Button size="sm" onClick={() => void restart()}>
                {tr("立即重启")}
              </Button>
            </div>
          )}

          {update.phase === 'error' && (
            <p role="alert" className="mt-3 text-xs leading-5 text-destructive">
              {tr("更新失败：{message}", { message: update.message })}
            </p>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            {tr("诊断包")}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {tr("遇到问题时导出一个压缩包，附在反馈里即可。")}
          </p>
        </div>

        <div className="rounded-xl border border-border bg-muted/25 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <FileArchive className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">
                  {tr("导出诊断包…")}
                </p>
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  {tr(
                    "包含版本、系统、数据库计数、脱敏后的设置与日志尾部；不含字幕、音频、数据库文件、术语表或 API Key。",
                  )}
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void exportBundle()}
              loading={diagBusy}
            >
              {tr("导出")}
            </Button>
          </div>
          {diagNote && (
            <p className="mt-3 break-all text-[11px] leading-5 text-muted-foreground">
              {diagNote}
            </p>
          )}
          {diagError && (
            <p role="alert" className="mt-3 text-xs leading-5 text-destructive">
              {tr("导出失败：{message}", { message: diagError })}
            </p>
          )}
        </div>
      </section>

      <p className="flex items-start gap-2 text-[11px] leading-5 text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
        {tr(
          "更新与诊断都不上传文件：更新只从发布源下载，诊断包只写到你选择的路径。",
        )}
      </p>
    </div>
  )
}
