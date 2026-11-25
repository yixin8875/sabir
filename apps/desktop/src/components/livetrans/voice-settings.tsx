import { tr } from '@/lib/i18n'
import {
  useEffect,
  useImperativeHandle,
  useState,
  type Ref,
} from 'react'
import { Trash2, Volume2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { formatBytes } from '@/lib/asr'
import {
  cancelVoiceDownload,
  deleteVoiceModel,
  downloadVoiceModel,
  saveVoiceSettings,
  type VoiceDownloadEvent,
  type VoiceSettings,
  type VoiceSettingsView,
} from '@/lib/voice'
import type { SettingsPanelHandle } from './recognition-settings'
import { cn } from '@/lib/utils'

type DownloadState = {
  downloaded: number
  total: number
  file: string
  error: string | null
}

type VoiceSettingsProps = {
  view: VoiceSettingsView | null
  onReload: () => Promise<void>
  onSaved: (view: VoiceSettingsView) => void
  onDirtyChange: (dirty: boolean) => void
  ref?: Ref<SettingsPanelHandle>
}

export function VoiceSettings({
  view,
  onReload,
  onSaved,
  onDirtyChange,
  ref,
}: VoiceSettingsProps) {
  const [form, setForm] = useState<VoiceSettings>(
    view?.settings ?? { enabled: false },
  )
  const [download, setDownload] = useState<DownloadState | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const settingsKey = view ? JSON.stringify(view.settings) : ''
  useEffect(() => {
    if (!view) return
    setForm(view.settings)
    setError(null)
    setConfirmDelete(false)
  }, [settingsKey, view])

  useEffect(() => {
    onDirtyChange(JSON.stringify(form) !== settingsKey)
  }, [form, settingsKey, onDirtyChange])

  async function save() {
    setError(null)
    try {
      const next = await saveVoiceSettings(form)
      onSaved(next)
      setForm(next.settings)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      throw cause
    }
  }

  useImperativeHandle(ref, () => ({ save }))

  async function startDownload() {
    setDownload({
      downloaded: 0,
      total: view?.model.bytes ?? 0,
      file: '',
      error: null,
    })
    setError(null)
    try {
      await downloadVoiceModel((event: VoiceDownloadEvent) => {
        if (event.type === 'progress') {
          setDownload({
            downloaded: event.downloaded,
            total: event.total,
            file: event.file,
            error: null,
          })
        } else if (event.type === 'done') {
          setDownload(null)
          void onReload()
        } else if (event.type === 'error') {
          setDownload((current) => ({
            downloaded: current?.downloaded ?? 0,
            total: current?.total ?? 0,
            file: current?.file ?? '',
            error: event.message,
          }))
        } else {
          setDownload(null)
        }
      })
    } catch (cause) {
      setDownload(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  function cancelDownload() {
    cancelVoiceDownload()
    setDownload(null)
  }

  async function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    setConfirmDelete(false)
    setError(null)
    try {
      onSaved(await deleteVoiceModel())
      setForm({ enabled: false })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const model = view?.model ?? null
  const installed = Boolean(model?.installed)
  const downloading = Boolean(model?.downloading && !download)
  const percent =
    download && download.total > 0
      ? Math.min(100, Math.round((download.downloaded / download.total) * 100))
      : 0
  const busy = Boolean(download && !download.error)

  return (
    <div className="space-y-6">
      <p className="text-sm leading-6 text-muted-foreground">
        {tr(
          "每句话翻译完成后，由本机运行的语音模型立即朗读，按原文顺序播放。需要先下载模型；配音默认关闭。",
        )}
      </p>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-foreground">
          {tr("语音模型")}
        </h2>
        {model ? (
          <div className="rounded-xl border border-border bg-muted/25 p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <Volume2 className="size-4 text-muted-foreground" />
                    {model.title}
                  </span>
                  {installed && (
                    <Badge variant="success" size="sm">
                      {tr("已安装")}
                    </Badge>
                  )}
                  {downloading && (
                    <Badge variant="secondary" size="sm">
                      {tr("下载中")}
                    </Badge>
                  )}
                </div>
                <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                  {tr('{size} · 103 个音色，24 kHz，约半秒开口', {
                    size: `${(model.bytes / (1024 * 1024)).toFixed(1)} MB`,
                  })}
                </p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {model.note}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {busy ? (
                  <Button variant="outline" size="sm" onClick={cancelDownload}>
                    {tr("取消")}
                  </Button>
                ) : installed ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className={cn(
                      confirmDelete &&
                        'border-destructive/40 text-destructive-foreground',
                    )}
                    onClick={() => void handleDelete()}
                    onBlur={() => setConfirmDelete(false)}
                  >
                    <Trash2 />
                    {confirmDelete ? tr("确认删除") : tr("删除")}
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => void startDownload()}>
                    {tr("下载")}
                  </Button>
                )}
              </div>
            </div>

            {download && !download.error && (
              <div className="mt-3 space-y-1.5">
                <Progress value={percent} className="w-full" />
                <div className="flex justify-between gap-3 text-[11px] text-muted-foreground">
                  <span className="truncate">
                    {download.file || tr("准备中…")}
                  </span>
                  <span className="tnum shrink-0">
                    {formatBytes(download.downloaded)} /{' '}
                    {formatBytes(download.total)}
                  </span>
                </div>
              </div>
            )}
            {download?.error && (
              <p className="mt-2 text-xs leading-5 text-destructive-foreground">
                {download.error}
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{tr("读取中…")}</p>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex items-center gap-3">
          <Switch
            id="voice-enabled"
            checked={form.enabled}
            disabled={!installed}
            onCheckedChange={(value) =>
              setForm((current) => ({ ...current, enabled: value }))
            }
          />
          <Label htmlFor="voice-enabled">{tr("朗读译文")}</Label>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          {installed
            ? tr("每句译文完成后立即朗读；停止录音、暂停或关闭页面时停止播放。")
            : tr("先下载上面的模型，才能打开配音。")}
        </p>
      </section>

      {error && (
        <p className="text-xs leading-5 text-destructive-foreground">{error}</p>
      )}
    </div>
  )
}
