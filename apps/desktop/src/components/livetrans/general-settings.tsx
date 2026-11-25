import { setLocale, tr } from '@/lib/i18n'
import {
  useEffect,
  useImperativeHandle,
  useState,
  type Ref,
} from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  DEFAULT_APP_SETTINGS,
  getAppSettings,
  pickExportDir,
  saveAppSettings,
  type AppSettings,
} from '@/lib/app-settings'
import {
  getAsrSettings,
  saveAsrSettings,
  type AsrSettingsView,
} from '@/lib/asr'
import {
  getAudioSettings,
  saveAudioSettings,
  type AudioSettings,
  type AudioSource,
} from '@/lib/audio'
import {
  UI_SCALES,
  saveGeneralSettings,
  type GeneralSettings,
} from '@/lib/general'
import {
  getTranslateSettings,
  saveTranslateSettings,
  type TargetLang,
  type TranslateSettingsView,
} from '@/lib/translation'
import type { SettingsPanelHandle } from './recognition-settings'

const AUDIO_SOURCES: { value: AudioSource; label: string }[] = [
  { value: 'system', label: tr("系统声音") },
  { value: 'microphone', label: tr("麦克风") },
  { value: 'both', label: tr("系统声音 + 麦克风") },
  { value: 'process', label: tr("单个应用") },
]

const ASR_LANGUAGES = [
  { value: 'auto', label: tr("自动识别") },
  { value: 'en', label: tr("英文") },
  { value: 'zh', label: tr("中文") },
]

const TARGET_LANGUAGES: { value: TargetLang; label: string }[] = [
  { value: 'zh-Hans', label: tr("简体中文") },
  { value: 'zh-Hant', label: tr("繁体中文") },
  { value: 'en', label: tr("英文") },
]

const INTERFACE_LANGUAGES: { value: string; label: string }[] = [
  { value: 'zh-Hans', label: tr("简体中文") },
  { value: 'en', label: 'English' },
]

export type GeneralSaveResult = {
  general: GeneralSettings
  audio?: AudioSettings
  asr?: AsrSettingsView
  translate?: TranslateSettingsView
}

type GeneralSettingsPanelProps = {
  general: GeneralSettings
  audio: AudioSettings
  asrView: AsrSettingsView | null
  translateView: TranslateSettingsView | null
  onSaved: (result: GeneralSaveResult) => void
  onDirtyChange: (dirty: boolean) => void
  onOpenRecognition: () => void
  ref?: Ref<SettingsPanelHandle>
}

/**
 * The overview page: defaults that affect every session. It only writes the
 * fields the user actually changed, reading the latest saved settings first so
 * edits made on the other panels are never clobbered.
 */
export function GeneralSettingsPanel({
  general,
  audio,
  asrView,
  translateView,
  onSaved,
  onDirtyChange,
  onOpenRecognition,
  ref,
}: GeneralSettingsPanelProps) {
  const [generalForm, setGeneralForm] = useState(general)
  const [source, setSource] = useState<AudioSource>(audio.source)
  const [language, setLanguage] = useState(
    asrView?.settings.language ?? 'auto',
  )
  const [targetLang, setTargetLang] = useState<TargetLang>(
    translateView?.settings.targetLang ?? 'zh-Hans',
  )
  const [error, setError] = useState<string | null>(null)
  const [appSettings, setAppSettings] = useState<AppSettings>(
    DEFAULT_APP_SETTINGS,
  )
  const [savedApp, setSavedApp] = useState<AppSettings>(DEFAULT_APP_SETTINGS)
  const appKey = JSON.stringify(appSettings)
  const savedAppKey = JSON.stringify(savedApp)

  const generalKey = JSON.stringify(general)
  const savedLanguage = asrView?.settings.language ?? null
  const savedTarget = translateView?.settings.targetLang ?? null

  useEffect(() => {
    setGeneralForm(general)
    // Only re-sync when a save changes the stored preferences.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generalKey])

  useEffect(() => {
    setSource(audio.source)
  }, [audio.source])

  useEffect(() => {
    if (savedLanguage) setLanguage(savedLanguage)
  }, [savedLanguage])

  useEffect(() => {
    if (savedTarget) setTargetLang(savedTarget)
  }, [savedTarget])

  useEffect(() => {
    let alive = true
    void getAppSettings().then((next) => {
      if (!alive) return
      setAppSettings(next)
      setSavedApp(next)
    })
    return () => {
      alive = false
    }
  }, [])

  async function chooseExportDir() {
    const dir = await pickExportDir()
    if (!dir) return
    setAppSettings((current) => ({ ...current, exportDir: dir }))
  }

  const dirty =
    JSON.stringify(generalForm) !== generalKey ||
    source !== audio.source ||
    (savedLanguage !== null && language !== savedLanguage) ||
    (savedTarget !== null && targetLang !== savedTarget) ||
    appKey !== savedAppKey

  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])

  async function save() {
    setError(null)
    try {
      let nextApp = savedApp
      if (appKey !== savedAppKey) {
        nextApp = await saveAppSettings(appSettings)
        setAppSettings(nextApp)
        setSavedApp(nextApp)
      }

      let nextAudio: AudioSettings | undefined
      if (source !== audio.source) {
        const latest = await getAudioSettings()
        nextAudio = await saveAudioSettings({ ...latest, source })
      }

      let nextAsr: AsrSettingsView | undefined
      if (savedLanguage !== null && language !== savedLanguage) {
        const latest = await getAsrSettings()
        nextAsr =
          latest.settings.language === language
            ? latest
            : await saveAsrSettings({ ...latest.settings, language })
      }

      let nextTranslate: TranslateSettingsView | undefined
      if (savedTarget !== null && targetLang !== savedTarget) {
        const latest = await getTranslateSettings()
        nextTranslate =
          latest.settings.targetLang === targetLang
            ? latest
            : await saveTranslateSettings({
                settings: { ...latest.settings, targetLang },
                consent: false,
              })
      }

      onSaved({
        general: saveGeneralSettings(generalForm),
        audio: nextAudio,
        asr: nextAsr,
        translate: nextTranslate,
      })

      // Module-level label tables are built at import time, so a language
      // change only takes effect after the window reloads.
      if (nextApp.locale !== savedApp.locale) {
        setLocale(nextApp.locale)
        window.location.reload()
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message || tr("保存失败，请稍后再试。"))
      throw cause
    }
  }

  useImperativeHandle(ref, () => ({ save }))

  return (
    <div className="space-y-7">
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{tr("语言与声音")}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {tr("决定新会话默认从哪里收音、按什么语言识别和翻译。")}
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="general-interface">{tr("界面语言")}</Label>
            <Select
              value={appSettings.locale}
              onValueChange={(value: string | null) => {
                if (!value) return
                setAppSettings((current) => ({
                  ...current,
                  locale: value === 'en' ? 'en' : 'zh-Hans',
                }))
              }}
              items={INTERFACE_LANGUAGES}
            >
              <SelectTrigger id="general-interface" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {INTERFACE_LANGUAGES.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <p className="text-[11px] leading-4 text-muted-foreground">
              {tr("保存后重载界面；识别与翻译的语言单独设置。")}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="general-source">{tr("默认音源")}</Label>
            <Select
              value={source}
              onValueChange={(value: string | null) => {
                if (!value) return
                setSource(value as AudioSource)
              }}
              items={AUDIO_SOURCES}
            >
              <SelectTrigger id="general-source" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {AUDIO_SOURCES.map((item) => (
                  <SelectItem
                    key={item.value}
                    value={item.value}
                    disabled={item.value === 'process' && !audio.processId}
                  >
                    {item.value === 'process' && !audio.processId
                      ? tr("单个应用（尚未选择）")
                      : item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <p className="text-[11px] leading-4 text-muted-foreground">
              {source === 'process'
                ? tr("只采集选中的应用；设备与应用在“识别”页选择。")
                : tr("设备与通道在“识别”页调整，下一次开始录音时生效。")}
            </p>
            {source === 'process' && !audio.processId && (
              <Button variant="outline" size="sm" onClick={onOpenRecognition}>
                {tr("去“识别”页选择应用…")}
              </Button>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="general-scale">{tr("字号")}</Label>
            <Select
              value={String(generalForm.uiScale)}
              onValueChange={(value: string | null) => {
                if (!value) return
                setGeneralForm((current) => ({
                  ...current,
                  uiScale: Number(value),
                }))
              }}
              items={UI_SCALES.map((scale) => ({
                value: String(scale),
                label: `${scale}%`,
              }))}
            >
              <SelectTrigger id="general-scale" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {UI_SCALES.map((scale) => (
                  <SelectItem key={scale} value={String(scale)}>
                    {scale}%
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <p className="text-[11px] leading-4 text-muted-foreground">
              {tr("缩放整个界面，保存后立即生效。")}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="general-language">{tr("识别语言")}</Label>
            <Select
              value={language}
              onValueChange={(value: string | null) => {
                if (!value) return
                setLanguage(value)
              }}
              items={ASR_LANGUAGES}
            >
              <SelectTrigger id="general-language" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {ASR_LANGUAGES.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <p className="text-[11px] leading-4 text-muted-foreground">
              {tr("Whisper 模型按此语言解码；其他模型以模型自身为准。")}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="general-target">{tr("翻译成")}</Label>
            <Select
              value={targetLang}
              onValueChange={(value: string | null) => {
                if (!value) return
                setTargetLang(value as TargetLang)
              }}
              items={TARGET_LANGUAGES}
            >
              <SelectTrigger id="general-target" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {TARGET_LANGUAGES.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <p className="text-[11px] leading-4 text-muted-foreground">
              {tr("字幕译文的语言；识别始终在本机完成。")}
            </p>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{tr("窗口")}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {tr("控制主窗口与录音浮标的显示方式。")}
          </p>
        </div>

        <div className="divide-y divide-border rounded-xl border border-border">
          <div className="flex items-center justify-between gap-4 px-4 py-3.5">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{tr("主窗口置顶")}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {tr("字幕始终压在其他窗口上方。")}
              </p>
            </div>
            <Switch
              checked={generalForm.alwaysOnTop}
              onCheckedChange={(checked: boolean) =>
                setGeneralForm((current) => ({
                  ...current,
                  alwaysOnTop: checked,
                }))
              }
              aria-label={tr("主窗口置顶")}
            />
          </div>

          <div className="flex items-center justify-between gap-4 px-4 py-3.5">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{tr("显示录音浮标")}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {tr("记录时在屏幕角落显示一个可拖动的迷你控制条。")}
              </p>
            </div>
            <Switch
              checked={generalForm.floatEnabled}
              onCheckedChange={(checked: boolean) =>
                setGeneralForm((current) => ({
                  ...current,
                  floatEnabled: checked,
                }))
              }
              aria-label={tr("显示录音浮标")}
            />
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{tr("导出")}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {tr("Markdown、JSONL 与 SRT 文件保存到这里；目录不存在时会自动创建。")}
          </p>
        </div>

        <div className="space-y-2">
          <Label>{tr("导出目录")}</Label>
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1 break-all rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs leading-5 text-foreground">
              {appSettings.exportDir ?? tr("默认：文档目录下的 Livetrans")}
            </div>
            <Button variant="outline" size="sm" onClick={() => void chooseExportDir()}>
              {tr("浏览…")}
            </Button>
            {appSettings.exportDir && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setAppSettings((current) => ({ ...current, exportDir: null }))
                }
              >
                {tr("恢复默认")}
              </Button>
            )}
          </div>
        </div>
      </section>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
