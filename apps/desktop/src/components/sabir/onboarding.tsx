import { tr } from '@/lib/i18n'
import { useState } from 'react'
import {
  ArrowRight,
  AudioLines,
  Check,
  Download,
  HardDrive,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  downloadAsrModel,
  formatBytes,
  getAsrSettings,
  saveAsrSettings,
  type AsrDownloadEvent,
  type AsrSettingsView,
} from '@/lib/asr'
import {
  saveAudioSettings,
  type AudioSettings,
  type AudioSource,
} from '@/lib/audio'
import { cn } from '@/lib/utils'

type OnboardingProps = {
  asrView: AsrSettingsView | null
  audio: AudioSettings
  onAudioSaved: (settings: AudioSettings) => void
  onAsrSaved: (view: AsrSettingsView) => void
  onComplete: () => void
}

const SOURCES: {
  value: AudioSource
  title: string
  note: string
}[] = [
  {
    value: 'system',
    title: tr("系统声音"),
    note: tr("采集正在播放的课程、会议、视频（WASAPI 回环）"),
  },
  {
    value: 'microphone',
    title: tr("麦克风"),
    note: tr("采集本机麦克风，适合面对面会议"),
  },
  {
    value: 'both',
    title: tr("系统声音 + 麦克风"),
    note: tr("两路混音：线上声音与现场说话一起进字幕"),
  },
]

const LISTEN_LANGUAGES = [
  {
    value: 'en',
    title: tr("英文为主"),
    note: tr("课程、直播、会议以英文为主"),
  },
  {
    value: 'auto',
    title: tr("中英混合"),
    note: tr("两种语言都会出现，自动识别"),
  },
  {
    value: 'zh',
    title: tr("中文为主"),
    note: tr("中文课程或会议"),
  },
]

const TOTAL_STEPS = 3

type Progress = {
  downloaded: number
  total: number
  file: string
}

export function Onboarding({
  asrView,
  audio,
  onAudioSaved,
  onAsrSaved,
  onComplete,
}: OnboardingProps) {
  const [step, setStep] = useState(0)
  const [source, setSource] = useState<AudioSource>(audio.source)
  const [savingSource, setSavingSource] = useState(false)
  const [savingLanguage, setSavingLanguage] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [downloaded, setDownloaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The backend recommends a model for the chosen recognition language, so the
  // card below follows the language instead of a fixed catalogue id.
  const language = asrView?.settings.language ?? 'auto'
  const recommended = asrView?.models.find((model) => model.recommended) ?? null
  const ready = Boolean(asrView?.ready) || downloaded

  function finish() {
    window.localStorage.setItem('sabir-onboarded', '1')
    onComplete()
  }

  async function next() {
    setError(null)
    if (step === 0) {
      setStep(1)
      return
    }
    if (step === 1) {
      if (source !== audio.source) {
        setSavingSource(true)
        try {
          onAudioSaved(await saveAudioSettings({ ...audio, source }))
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
          setSavingSource(false)
          return
        }
        setSavingSource(false)
      }
      setStep(2)
      return
    }
    finish()
  }

  async function chooseLanguage(value: string) {
    if (value === language || savingLanguage) return
    setError(null)
    setSavingLanguage(true)
    try {
      const latest = await getAsrSettings()
      onAsrSaved(await saveAsrSettings({ ...latest.settings, language: value }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSavingLanguage(false)
    }
  }

  async function downloadRecommended() {
    if (!recommended) return
    setError(null)
    setProgress({ downloaded: 0, total: recommended.bytes, file: '' })
    try {
      await downloadAsrModel(recommended.id, async (event: AsrDownloadEvent) => {
        if (event.type === 'progress') {
          setProgress({
            downloaded: event.downloaded,
            total: event.total,
            file: event.file,
          })
        } else if (event.type === 'done') {
          setProgress(null)
          setDownloaded(true)
          try {
            const latest = await getAsrSettings()
            onAsrSaved(
              await saveAsrSettings({
                ...latest.settings,
                model: recommended.id,
              }),
            )
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
          }
        } else if (event.type === 'error') {
          setProgress(null)
          setError(event.message)
        } else {
          setProgress(null)
        }
      })
    } catch (cause) {
      setProgress(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : 0

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={tr("首次启动引导")}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]"
    >
      <div className="flex w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <span className="text-xs font-medium text-muted-foreground">
            {tr('第 {n} 步，共 {total} 步', { n: step + 1, total: TOTAL_STEPS })}
          </span>
          <div className="flex items-center gap-1.5" aria-hidden="true">
            {Array.from({ length: TOTAL_STEPS }, (_, index) => (
              <span
                key={index}
                className={cn(
                  'h-1.5 rounded-full transition-all',
                  index === step
                    ? 'w-6 bg-foreground'
                    : index < step
                      ? 'w-1.5 bg-foreground/50'
                      : 'w-1.5 bg-border',
                )}
              />
            ))}
          </div>
        </div>

        <div className="px-6 py-6">
          {step === 0 && (
            <div className="space-y-5">
              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  Sabir
                </p>
                <h2 className="mt-1 text-xl font-semibold text-foreground">
                  {tr("欢迎使用 Sabir")}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {tr("三步把它准备好。")}
                </p>
              </div>
              <ul className="space-y-3">
                {[
                  {
                    icon: ShieldCheck,
                    title: tr("音频不离开这台电脑"),
                    note: tr(
                      "识别与翻译都在本机完成，只有你授权的句子文本会发往所选服务商。",
                    ),
                  },
                  {
                    icon: Sparkles,
                    title: tr("边说边出字"),
                    note: tr(
                      "流式模型在说话过程中就给字幕，翻译在句子定稿后进行。",
                    ),
                  },
                  {
                    icon: HardDrive,
                    title: tr("会话与导出都由你掌握"),
                    note: tr(
                      "历次字幕存在本机 SQLite，导出位置可在设置里随时更改。",
                    ),
                  },
                ].map((item) => {
                  const Icon = item.icon
                  return (
                    <li key={item.title} className="flex gap-3">
                      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
                        <Icon className="size-4" />
                      </span>
                      <span>
                        <span className="block text-sm font-medium text-foreground">
                          {item.title}
                        </span>
                        <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                          {item.note}
                        </span>
                      </span>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-foreground">
                  {tr("选择音频来源")}
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {tr("之后可在设置里更改。")}
                </p>
              </div>
              <div className="space-y-2">
                {SOURCES.map((item) => {
                  const active = source === item.value
                  return (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => setSource(item.value)}
                      aria-pressed={active}
                      className={cn(
                        'flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors',
                        active
                          ? 'border-foreground/40 bg-accent/60'
                          : 'border-border hover:bg-accent/30',
                      )}
                    >
                      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                        <AudioLines className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-foreground">
                          {item.title}
                        </span>
                        <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                          {item.note}
                        </span>
                      </span>
                      {active && <Check className="mt-1 size-4 shrink-0" />}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-foreground">
                  {tr("选择识别模型")}
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {tr("按你主要听的语言挑一个模型，边说边出字。")}
                </p>
              </div>

              <div className="space-y-2">
                <p className="text-xs font-medium text-foreground">
                  {tr("我主要听哪种语言？")}
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {LISTEN_LANGUAGES.map((item) => {
                    const active = language === item.value
                    return (
                      <button
                        key={item.value}
                        type="button"
                        aria-pressed={active}
                        disabled={savingLanguage}
                        onClick={() => void chooseLanguage(item.value)}
                        className={cn(
                          'rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-60',
                          active
                            ? 'border-foreground/40 bg-accent/60'
                            : 'border-border hover:bg-accent/30',
                        )}
                      >
                        <span className="block text-[13px] font-medium text-foreground">
                          {item.title}
                        </span>
                        <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
                          {item.note}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="rounded-xl border border-border p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">
                      {recommended?.title ?? tr("识别模型")}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {recommended?.note ??
                        tr("按你主要听的语言推荐一个识别模型。")}
                    </p>
                  </div>
                  {recommended && (
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {formatBytes(recommended.bytes)}
                    </span>
                  )}
                </div>

                <div className="mt-4">
                  {ready ? (
                    <p className="flex items-center gap-1.5 text-xs text-foreground">
                      <Check className="size-4" />
                      {tr("已安装，可以直接开始")}
                    </p>
                  ) : progress ? (
                    <div className="space-y-1.5">
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-foreground transition-all"
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        {percent}%{progress.file ? ` · ${progress.file}` : ''}
                      </p>
                    </div>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void downloadRecommended()}
                    >
                      <Download />
                      {tr("下载推荐模型")}
                    </Button>
                  )}
                </div>
              </div>

              <p className="text-[11px] leading-5 text-muted-foreground">
                {tr("只下载权重文件，语音始终留在本机。")}
              </p>
            </div>
          )}

          {error && (
            <p role="alert" className="mt-4 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border px-6 py-4">
          {step === 2 ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={finish}
            >
              {tr("稍后再选")}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            {step > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setStep(step - 1)}
              >
                {tr("上一步")}
              </Button>
            )}
            <Button size="sm" loading={savingSource} onClick={() => void next()}>
              {step === TOTAL_STEPS - 1 ? tr("完成") : tr("下一步")}
              <ArrowRight />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
