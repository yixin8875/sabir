import { tr } from '@/lib/i18n'
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from 'react'
import {
  AppWindow,
  ChevronRight,
  FolderOpen,
  Layers,
  Mic,
  MonitorSpeaker,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  browseModelDir,
  cancelAsrDownload,
  deleteAsrModel,
  downloadAsrModel,
  formatBytes,
  saveAsrSettings,
  DEFAULT_ASR_SETTINGS,
  type AsrDownloadEvent,
  type AsrModelInfo,
  type AsrSettings,
  type AsrSettingsView,
} from '@/lib/asr'
import {
  DEFAULT_AUDIO_SETTINGS,
  getAudioSettings,
  listAudioDevices,
  listAudioProcesses,
  saveAudioSettings,
  type AudioDevices,
  type AudioProcess,
  type AudioSettings,
} from '@/lib/audio'
import { probeEnvironment, type Environment } from '@/lib/environment'
import { cn } from '@/lib/utils'

export type SettingsPanelHandle = {
  save: () => Promise<void>
}

type DownloadState = {
  downloaded: number
  total: number
  file: string
  error: string | null
}

type RecognitionSettingsProps = {
  view: AsrSettingsView | null
  onReload: () => Promise<void>
  onSaved: (view: AsrSettingsView) => void
  onDirtyChange: (dirty: boolean) => void
  onAudioSaved?: (settings: AudioSettings) => void
  ref?: Ref<SettingsPanelHandle>
}

function isPath(value: string | null): boolean {
  return Boolean(value && !/^[a-z0-9-]+$/i.test(value))
}

export function RecognitionSettings({
  view,
  onReload,
  onSaved,
  onDirtyChange,
  onAudioSaved,
  ref,
}: RecognitionSettingsProps) {
  const [form, setForm] = useState<AsrSettings>(
    view?.settings ?? DEFAULT_ASR_SETTINGS,
  )
  const [downloads, setDownloads] = useState<Record<string, DownloadState>>({})
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rescanning, setRescanning] = useState(false)
  const [environment, setEnvironment] = useState<Environment | null>(null)
  const [audio, setAudio] = useState<AudioSettings>(DEFAULT_AUDIO_SETTINGS)
  const [audioDevices, setAudioDevices] = useState<AudioDevices | null>(null)
  const [audioProcesses, setAudioProcesses] = useState<AudioProcess[] | null>(
    null,
  )

  useEffect(() => {
    void probeEnvironment()
      .then(setEnvironment)
      .catch(() => {})
    void getAudioSettings()
      .then(setAudio)
      .catch(() => {})
    void listAudioDevices()
      .then(setAudioDevices)
      .catch(() => {})
    void listAudioProcesses()
      .then(setAudioProcesses)
      .catch(() => setAudioProcesses([]))
  }, [])

  async function patchAudio(update: Partial<AudioSettings>) {
    const next = { ...audio, ...update }
    setAudio(next)
    try {
      const saved = await saveAudioSettings(next)
      setAudio(saved)
      onAudioSaved?.(saved)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const usesOutput = audio.source === 'system' || audio.source === 'both'
  const usesInput = audio.source === 'microphone' || audio.source === 'both'
  const outputOptions = audioDevices?.outputs ?? []
  const inputOptions = audioDevices?.inputs ?? []

  const formRef = useRef(form)
  formRef.current = form

  const settingsKey = view ? JSON.stringify(view.settings) : ''
  useEffect(() => {
    if (view) setForm(view.settings)
  }, [settingsKey, view])

  useEffect(() => {
    onDirtyChange(JSON.stringify(form) !== settingsKey)
  }, [form, settingsKey, onDirtyChange])

  function patch(update: Partial<AsrSettings>) {
    setForm((current) => ({ ...current, ...update }))
  }

  async function save() {
    setError(null)
    try {
      const next = await saveAsrSettings(formRef.current)
      onSaved(next)
      setForm(next.settings)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      throw cause
    }
  }

  useImperativeHandle(ref, () => ({ save }))

  async function afterDownload(modelId: string) {
    setDownloads((current) => {
      const next = { ...current }
      delete next[modelId]
      return next
    })
    await onReload()
    const current = formRef.current
    if (!current.model) {
      try {
        const next = await saveAsrSettings({ ...current, model: modelId })
        onSaved(next)
        setForm(next.settings)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
  }

  async function startDownload(model: AsrModelInfo) {
    setError(null)
    setDownloads((current) => ({
      ...current,
      [model.id]: { downloaded: 0, total: model.bytes, file: '', error: null },
    }))
    try {
      await downloadAsrModel(model.id, (event: AsrDownloadEvent) => {
        if (event.type === 'progress') {
          setDownloads((current) => ({
            ...current,
            [event.modelId]: {
              downloaded: event.downloaded,
              total: event.total,
              file: event.file,
              error: null,
            },
          }))
        } else if (event.type === 'done') {
          void afterDownload(event.modelId)
        } else if (event.type === 'cancelled') {
          setDownloads((current) => {
            const next = { ...current }
            delete next[event.modelId]
            return next
          })
        } else {
          setDownloads((current) => ({
            ...current,
            [event.modelId]: {
              downloaded: current[event.modelId]?.downloaded ?? 0,
              total: current[event.modelId]?.total ?? model.bytes,
              file: current[event.modelId]?.file ?? '',
              error: event.message,
            },
          }))
        }
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setDownloads((current) => {
        const next = { ...current }
        delete next[model.id]
        return next
      })
    }
  }

  async function handleDelete(modelId: string) {
    if (confirmDelete !== modelId) {
      setConfirmDelete(modelId)
      return
    }
    setConfirmDelete(null)
    setError(null)
    try {
      onSaved(await deleteAsrModel(modelId))
      await onReload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function handleBrowse() {
    const dir = await browseModelDir()
    if (dir) patch({ model: dir })
  }

  async function handleRescan() {
    setRescanning(true)
    try {
      await onReload()
    } finally {
      setRescanning(false)
    }
  }

  const models = view?.models ?? []
  const installed = models.filter((model) => model.installed)
  const selectedValue = isPath(form.model) ? 'custom' : (form.model ?? '')

  return (
    <div className="space-y-7">
      {!view?.ready && (
        <div className="rounded-lg border border-warning/35 bg-warning/8 p-3 text-xs leading-5 text-foreground">
          {tr("还没有可用的识别模型。先下载一个，或用「浏览…」选择已有模型目录；在此之前")}
          {tr("Listen 会先打开这个页面。")}
        </div>
      )}

      {!view?.ready && environment && (
        <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs leading-5 text-foreground">
          <span className="font-medium">{tr("本机环境 ·")} </span>
          {environment.reason}
          {environment.ollamaRunning && (
            <span className="text-muted-foreground">
              {' '}
              {tr('Ollama 正在运行（{n} 个模型），翻译页可直接选本地 LLM。', {
                n: environment.ollamaModels.length,
              })}
            </span>
          )}
        </div>
      )}

      <section className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">{tr("下载模型")}</h2>
          <span className="text-[11px] text-muted-foreground">
            {tr("只下载权重文件，语音始终留在本机")}
          </span>
        </div>

        <div className="divide-y divide-border rounded-xl border border-border bg-background">
          {models.map((model) => {
            const download = downloads[model.id]
            const percent =
              download && download.total > 0
                ? Math.min(
                    100,
                    Math.round((download.downloaded / download.total) * 100),
                  )
                : 0
            const busy = Boolean(download && !download.error)
            return (
              <div key={model.id} className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {model.title}
                      </span>
                      {model.recommended && (
                        <Badge variant="outline" size="sm">
                          {tr("推荐")}
                        </Badge>
                      )}
                      {model.kind === 'whisper' && (
                        <Badge variant="secondary" size="sm">
                          {tr("整段识别")}
                        </Badge>
                      )}
                      {model.installed && (
                        <Badge variant="success" size="sm">
                          {tr("已安装")}
                        </Badge>
                      )}
                      {model.downloading && !download && (
                        <Badge variant="secondary" size="sm">
                          {tr("下载中")}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {formatBytes(model.bytes)} · {model.note}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {busy ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void cancelAsrDownload(model.id)}
                      >
                        {tr("取消")}
                      </Button>
                    ) : model.installed ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className={cn(
                          confirmDelete === model.id &&
                            'border-destructive/40 text-destructive-foreground',
                        )}
                        onClick={() => void handleDelete(model.id)}
                        onBlur={() => setConfirmDelete(null)}
                      >
                        <Trash2 />
                        {confirmDelete === model.id ? tr("确认删除") : tr("删除")}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => void startDownload(model)}
                      >
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
            )
          })}
        </div>
      </section>

      <section className="space-y-2">
        <Label>{tr("模型")}</Label>
        <div className="flex flex-wrap items-start gap-2">
          <Select
            value={selectedValue}
            onValueChange={(value: string | null) => {
              if (!value || value === 'custom') return
              patch({ model: value })
            }}
            items={[
              ...installed.map((model) => ({
                value: model.id,
                label: model.title,
              })),
              ...(isPath(form.model)
                ? [{ value: 'custom', label: tr("自定义目录…") }]
                : []),
            ]}
          >
            <SelectTrigger className="min-w-64 flex-1">
              <SelectValue placeholder={tr("未选择模型")} />
            </SelectTrigger>
            <SelectPopup>
              {installed.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.title}
                </SelectItem>
              ))}
              {isPath(form.model) && (
                <SelectItem value="custom">{tr("自定义目录…")}</SelectItem>
              )}
            </SelectPopup>
          </Select>
          <Button variant="outline" onClick={() => void handleBrowse()}>
            <FolderOpen />
            {tr("浏览…")}
          </Button>
          <Button
            variant="outline"
            onClick={() => void handleRescan()}
            loading={rescanning}
          >
            <RefreshCw />
            {tr("重新扫描模型")}
          </Button>
        </div>
        <p className="break-all text-[11px] leading-5 text-muted-foreground">
          {view?.selectedDir
            ? tr('当前：{path}', { path: view.selectedDir })
            : tr("还没有可用的模型；下载后在底部保存。")}
        </p>
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">{tr("音频来源")}</h2>
          <span className="text-[11px] text-muted-foreground">
            {tr("改动即时保存，下次 Listen 生效")}
          </span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {[
            {
              value: 'system' as const,
              title: tr("系统声音"),
              hint: tr("采集正在播放的课程、会议、视频（WASAPI 回环）"),
              icon: MonitorSpeaker,
            },
            {
              value: 'microphone' as const,
              title: tr("麦克风"),
              hint: tr("采集本机麦克风，适合面对面会议"),
              icon: Mic,
            },
            {
              value: 'both' as const,
              title: tr("系统声音 + 麦克风"),
              hint: tr("两路混音：线上声音与现场说话一起进字幕"),
              icon: Layers,
            },
            {
              value: 'process' as const,
              title: tr("单个应用"),
              hint: tr("只采集某个应用的声音，系统通知与音乐不进来"),
              icon: AppWindow,
            },
          ].map((option) => {
            const selected = audio.source === option.value
            const Icon = option.icon
            return (
              <button
                key={option.value}
                type="button"
                onClick={() =>
                  void patchAudio({
                    source: option.value,
                    device: null,
                    micDevice: null,
                    processId: null,
                  })
                }
                className={cn(
                  'flex items-start gap-3 rounded-xl border p-3 text-left transition-colors',
                  selected
                    ? 'border-primary/60 bg-primary/5'
                    : 'border-border bg-background hover:bg-muted/50',
                )}
                aria-pressed={selected}
              >
                <Icon
                  className={cn(
                    'mt-0.5 size-4',
                    selected ? 'text-foreground' : 'text-muted-foreground',
                  )}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">
                    {option.title}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-5 text-muted-foreground">
                    {option.hint}
                  </span>
                </span>
              </button>
            )
          })}
        </div>

        {usesOutput && (
          <div className="flex flex-wrap items-center gap-2">
            <Label className="min-w-16">
              {usesInput ? tr("输出设备") : tr("设备")}
            </Label>
            <Select
              value={audio.device ?? 'default'}
              items={[
                { value: 'default', label: tr("默认设备") },
                ...outputOptions.map((device) => ({
                  value: device.id,
                  label: device.name,
                })),
              ]}
              onValueChange={(value: string | null) => {
                if (!value) return
                void patchAudio({ device: value === 'default' ? null : value })
              }}
            >
              <SelectTrigger className="min-w-64 flex-1">
                <SelectValue placeholder={tr("默认设备")} />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="default">{tr("默认设备")}</SelectItem>
                {outputOptions.map((device) => (
                  <SelectItem key={device.id} value={device.id}>
                    {device.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        )}

        {usesInput && (
          <div className="flex flex-wrap items-center gap-2">
            <Label className="min-w-16">{tr("输入设备")}</Label>
            <Select
              value={audio.micDevice ?? 'default'}
              items={[
                { value: 'default', label: tr("默认麦克风") },
                ...inputOptions.map((device) => ({
                  value: device.id,
                  label: device.name,
                })),
              ]}
              onValueChange={(value: string | null) => {
                if (!value) return
                void patchAudio({
                  micDevice: value === 'default' ? null : value,
                })
              }}
            >
              <SelectTrigger className="min-w-64 flex-1">
                <SelectValue placeholder={tr("默认麦克风")} />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="default">{tr("默认麦克风")}</SelectItem>
                {inputOptions.map((device) => (
                  <SelectItem key={device.id} value={device.id}>
                    {device.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        )}

        {audio.source === 'process' && (
          <div className="flex flex-wrap items-center gap-2">
            <Label className="min-w-16">{tr("应用")}</Label>
            <Select
              value={audio.processId ? String(audio.processId) : 'none'}
              items={[
                { value: 'none', label: tr("选择正在播放的应用") },
                ...(audioProcesses ?? []).map((process) => ({
                  value: String(process.pid),
                  label: `${process.name} · ${process.pid}`,
                })),
              ]}
              onValueChange={(value: string | null) => {
                if (!value) return
                void patchAudio({
                  processId: value === 'none' ? null : Number(value),
                })
              }}
            >
              <SelectTrigger className="min-w-64 flex-1">
                <SelectValue placeholder={tr("选择正在播放的应用")} />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="none">{tr("选择正在播放的应用")}</SelectItem>
                {(audioProcesses ?? []).map((process) => (
                  <SelectItem key={process.pid} value={String(process.pid)}>
                    {process.name} · {process.pid}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
              onClick={() =>
                void listAudioProcesses()
                  .then(setAudioProcesses)
                  .catch(() => setAudioProcesses([]))
              }
            >
              <RefreshCw />
              {tr("刷新")}
            </Button>
          </div>
        )}

        <p className="text-[11px] leading-5 text-muted-foreground">
          {tr("混音把两路 16 kHz 单声道相加；按进程采集走 WASAPI")}
          {tr("进程回环（Windows 10 2004 及以上），需要应用正在出声才会出现在列表里。")}
          {tr("设备名由系统提供。")}
        </p>
      </section>

      <section className="space-y-2">
        <Label>{tr("识别语言")}</Label>
        <div className="flex h-9 w-64 items-center rounded-lg border border-input bg-background px-3 text-sm text-foreground">
          {tr("自动识别")}
        </div>
        <p className="text-[11px] leading-5 text-muted-foreground">
          {tr("Zipformer 边说边判定语种；Whisper 按整句自动判定。选纯英文或纯中文模型时只出对应语言。")}
        </p>
      </section>

      <Collapsible>
        <CollapsibleTrigger className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <ChevronRight className="size-4 transition-transform data-panel-open:rotate-90" />
          {tr("高级")}
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="mt-4 space-y-5">
            <div className="space-y-2">
              <Label htmlFor="custom-model-dir">{tr("自定义模型路径")}</Label>
              <div className="flex gap-2">
                <Input
                  id="custom-model-dir"
                  value={isPath(form.model) ? (form.model ?? '') : ''}
                  onChange={(event) =>
                    patch({ model: event.target.value.trim() || null })
                  }
                  placeholder="/path/to/sherpa-model"
                  spellCheck={false}
                />
                <Button variant="outline" onClick={() => void handleBrowse()}>
                  {tr("浏览…")}
                </Button>
              </div>
              <p className="text-[11px] leading-5 text-muted-foreground">
                {tr("Zipformer 目录需要 encoder、decoder、joiner 和 tokens.txt；")}
                {tr("Whisper 目录需要 encoder、decoder 和 *-tokens.txt。保存后立即生效。")}
              </p>
            </div>

            <div className="grid grid-cols-2 items-start gap-4">
              <div className="space-y-2">
                <Label htmlFor="threads">{tr("线程数")}</Label>
                <Input
                  id="threads"
                  type="number"
                  min={1}
                  max={8}
                  className="w-28"
                  value={form.threads}
                  onChange={(event) =>
                    patch({
                      threads: Math.max(
                        1,
                        Math.min(8, Number(event.target.value) || 1),
                      ),
                    })
                  }
                />
                <p className="text-[11px] leading-5 text-muted-foreground">
                  {tr("识别占用的 CPU 核心，1–8。机器很忙时调到 2。")}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="models-root">{tr("下载位置")}</Label>
                <div className="flex gap-2">
                  <Input
                    id="models-root"
                    value={form.modelsRoot ?? ''}
                    onChange={(event) =>
                      patch({ modelsRoot: event.target.value.trim() || null })
                    }
                    placeholder={view?.modelsRoot || tr("应用数据目录")}
                    spellCheck={false}
                    className="font-mono text-[11px]"
                  />
                  <Button
                    variant="outline"
                    onClick={() => {
                      void browseModelDir().then((dir) => {
                        if (dir) patch({ modelsRoot: dir })
                      })
                    }}
                  >
                    {tr("更改…")}
                  </Button>
                </div>
                <p className="break-all text-[11px] leading-5 text-muted-foreground">
                  {tr('当前：{path}。保存后生效，之后下载的模型都放在这里。', {
                    path: view?.modelsRoot || '—',
                  })}
                </p>
              </div>
            </div>
          </div>
        </CollapsiblePanel>
      </Collapsible>

      {error && (
        <p className="rounded-lg border border-destructive/35 bg-destructive/6 px-3 py-2 text-xs leading-5 text-destructive-foreground">
          {error}
        </p>
      )}
    </div>
  )
}
