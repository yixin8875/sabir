import { tr } from '@/lib/i18n'
import { useEffect, useRef, useState } from 'react'
import {
  Languages,
  Mic,
  NotebookText,
  Plug,
  Settings2,
  Volume2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { AsrSettingsView } from '@/lib/asr'
import type { AudioSettings } from '@/lib/audio'
import type { GeneralSettings } from '@/lib/general'
import type { Glossary } from '@/lib/glossary'
import type { PluginSettingsView } from '@/lib/plugins'
import type { TranslateSettingsView } from '@/lib/translation'
import type { VoiceSettingsView } from '@/lib/voice'
import {
  GeneralSettingsPanel,
  type GeneralSaveResult,
} from './general-settings'
import { GlossarySettings } from './glossary-settings'
import {
  RecognitionSettings,
  type SettingsPanelHandle,
} from './recognition-settings'
import { PluginSettings } from './plugin-settings'
import { TranslationSettings } from './translation-settings'
import { VoiceSettings } from './voice-settings'
import { cn } from '@/lib/utils'

export type SettingsSection =
  | 'general'
  | 'recognition'
  | 'translation'
  | 'glossary'
  | 'voice'
  | 'plugins'

const SECTIONS: { id: SettingsSection; label: string; icon: typeof Mic }[] = [
  { id: 'general', label: tr("通用"), icon: Settings2 },
  { id: 'recognition', label: tr("识别"), icon: Mic },
  { id: 'translation', label: tr("翻译与聊天"), icon: Languages },
  { id: 'glossary', label: tr("场景与术语"), icon: NotebookText },
  { id: 'voice', label: tr("配音"), icon: Volume2 },
  { id: 'plugins', label: tr("插件"), icon: Plug },
]

const TITLES: Record<SettingsSection, string> = {
  general: tr("通用"),
  recognition: tr("识别"),
  translation: tr("翻译与聊天"),
  glossary: tr("场景与术语"),
  voice: tr("配音"),
  plugins: tr("插件"),
}

type SettingsDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialSection?: SettingsSection
  general: GeneralSettings
  audio: AudioSettings
  asrView: AsrSettingsView | null
  translateView: TranslateSettingsView | null
  onGeneralSaved: (result: GeneralSaveResult) => void
  onAsrReload: () => Promise<void>
  onAsrSaved: (view: AsrSettingsView) => void
  onTranslateReload: () => Promise<void>
  onTranslateSaved: (view: TranslateSettingsView) => void
  onGlossarySaved?: (glossary: Glossary) => void
  onAudioSaved?: (settings: AudioSettings) => void
  voiceView: VoiceSettingsView | null
  onVoiceReload: () => Promise<void>
  onVoiceSaved: (view: VoiceSettingsView) => void
  pluginView: PluginSettingsView | null
  onPluginReload: () => Promise<void>
  onPluginSaved: (view: PluginSettingsView) => void
}

export function SettingsDialog({
  open,
  onOpenChange,
  initialSection = 'general',
  general,
  audio,
  asrView,
  translateView,
  onGeneralSaved,
  onAsrReload,
  onAsrSaved,
  onTranslateReload,
  onTranslateSaved,
  onGlossarySaved,
  onAudioSaved,
  voiceView,
  onVoiceReload,
  onVoiceSaved,
  pluginView,
  onPluginReload,
  onPluginSaved,
}: SettingsDialogProps) {
  const [section, setSection] = useState<SettingsSection>(initialSection)
  const [dirty, setDirty] = useState({
    general: false,
    recognition: false,
    translation: false,
    glossary: false,
    voice: false,
    plugins: false,
  })
  const [saving, setSaving] = useState(false)
  const generalRef = useRef<SettingsPanelHandle>(null)
  const recognitionRef = useRef<SettingsPanelHandle>(null)
  const translationRef = useRef<SettingsPanelHandle>(null)
  const glossaryRef = useRef<SettingsPanelHandle>(null)
  const voiceRef = useRef<SettingsPanelHandle>(null)
  const pluginRef = useRef<SettingsPanelHandle>(null)

  useEffect(() => {
    if (!open) return
    setSection(initialSection)
    setDirty({
      general: false,
      recognition: false,
      translation: false,
      glossary: false,
      voice: false,
      plugins: false,
    })
  }, [open, initialSection])

  useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onOpenChange(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onOpenChange])

  if (!open) return null

  const anyDirty =
    dirty.general ||
    dirty.recognition ||
    dirty.translation ||
    dirty.glossary ||
    dirty.voice ||
    dirty.plugins

  async function handleSave() {
    setSaving(true)
    try {
      if (dirty.recognition) await recognitionRef.current?.save()
      if (dirty.translation) await translationRef.current?.save()
      if (dirty.glossary) await glossaryRef.current?.save()
      if (dirty.voice) await voiceRef.current?.save()
      if (dirty.plugins) await pluginRef.current?.save()
      // General goes last: it re-reads the latest audio/ASR/translation
      // settings, so it must see whatever the panels above just saved.
      if (dirty.general) await generalRef.current?.save()
      onOpenChange(false)
    } catch {
      // The panel that failed already shows the message next to its fields.
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={tr("设置")}
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/35 backdrop-blur-[2px] sm:p-6"
    >
      <div className="flex w-full max-w-5xl overflow-hidden border border-border bg-background shadow-2xl sm:rounded-xl">
        <aside className="hidden w-52 shrink-0 flex-col border-r border-border bg-muted/30 p-3 sm:flex">
          <p className="px-2 py-2 text-xs font-medium text-muted-foreground">
            Livetrans
          </p>
          <nav className="mt-1 space-y-0.5">
            {SECTIONS.map((item) => {
              const Icon = item.icon
              const active = section === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSection(item.id)}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                    active
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                  )}
                >
                  <Icon className="size-4" />
                  {item.label}
                </button>
              )
            })}
          </nav>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5 sm:px-6">
            <h1 className="text-lg font-semibold text-foreground">
              {TITLES[section]}
            </h1>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={tr("关闭设置")}
              onClick={() => onOpenChange(false)}
              className="text-muted-foreground"
            >
              <X />
            </Button>
          </header>

          <div className="flex gap-1 border-b border-border px-3 py-1.5 sm:hidden">
            {SECTIONS.map((item) => (
              <Button
                key={item.id}
                size="sm"
                variant={section === item.id ? 'secondary' : 'ghost'}
                onClick={() => setSection(item.id)}
              >
                {item.label}
              </Button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-6">
            <div className={section === 'general' ? 'block' : 'hidden'}>
              <GeneralSettingsPanel
                ref={generalRef}
                general={general}
                audio={audio}
                asrView={asrView}
                translateView={translateView}
                onSaved={onGeneralSaved}
                onOpenRecognition={() => setSection('recognition')}
                onDirtyChange={(value) =>
                  setDirty((current) =>
                    current.general === value
                      ? current
                      : { ...current, general: value },
                  )
                }
              />
            </div>
            <div className={section === 'recognition' ? 'block' : 'hidden'}>
              <RecognitionSettings
                ref={recognitionRef}
                view={asrView}
                onReload={onAsrReload}
                onSaved={onAsrSaved}
                onAudioSaved={onAudioSaved}
                onDirtyChange={(value) =>
                  setDirty((current) =>
                    current.recognition === value
                      ? current
                      : { ...current, recognition: value },
                  )
                }
              />
            </div>
            <div className={section === 'translation' ? 'block' : 'hidden'}>
              <TranslationSettings
                ref={translationRef}
                view={translateView}
                onReload={onTranslateReload}
                onSaved={onTranslateSaved}
                onDirtyChange={(value) =>
                  setDirty((current) =>
                    current.translation === value
                      ? current
                      : { ...current, translation: value },
                  )
                }
              />
            </div>
            <div className={section === 'glossary' ? 'block' : 'hidden'}>
              <GlossarySettings
                ref={glossaryRef}
                onSaved={onGlossarySaved}
                onDirtyChange={(value) =>
                  setDirty((current) =>
                    current.glossary === value
                      ? current
                      : { ...current, glossary: value },
                  )
                }
              />
            </div>
            <div className={section === 'voice' ? 'block' : 'hidden'}>
              <VoiceSettings
                ref={voiceRef}
                view={voiceView}
                onReload={onVoiceReload}
                onSaved={onVoiceSaved}
                onDirtyChange={(value) =>
                  setDirty((current) =>
                    current.voice === value
                      ? current
                      : { ...current, voice: value },
                  )
                }
              />
            </div>
            <div className={section === 'plugins' ? 'block' : 'hidden'}>
              <PluginSettings
                ref={pluginRef}
                view={pluginView}
                onReload={onPluginReload}
                onSaved={onPluginSaved}
                onDirtyChange={(value) =>
                  setDirty((current) =>
                    current.plugins === value
                      ? current
                      : { ...current, plugins: value },
                  )
                }
              />
            </div>
          </div>

          <footer className="flex items-center gap-3 border-t border-border px-5 py-3 sm:px-6">
            <p
              className={cn(
                'flex-1 text-xs',
                anyDirty ? 'text-warning-foreground' : 'text-muted-foreground',
              )}
            >
              {anyDirty ? tr("有未保存的更改") : tr("所有更改已保存")}
            </p>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {tr("取消")}
            </Button>
            <Button
              onClick={() => void handleSave()}
              loading={saving}
              disabled={!anyDirty}
            >
              {tr("保存")}
            </Button>
          </footer>
        </div>
      </div>
    </div>
  )
}
