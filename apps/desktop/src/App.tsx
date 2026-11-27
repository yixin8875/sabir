import { currentLocale, localize, setLocale, tr } from '@/lib/i18n'
import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { AskPanel } from '@/components/sabir/ask-panel'
import { ControlDock, TopBar } from '@/components/sabir/chrome'
import type {
  CaptionLine,
  CaptionState,
} from '@/components/sabir/caption-overlay'
import type { GeneralSaveResult } from '@/components/sabir/general-settings'
import { LibraryDialog } from '@/components/sabir/library-dialog'
import { Onboarding } from '@/components/sabir/onboarding'
import {
  SettingsDialog,
  type SettingsSection,
} from '@/components/sabir/settings-dialog'
import { TranscriptView } from '@/components/sabir/transcript'
import { useAsrSettings } from '@/hooks/use-asr-settings'
import { useAppearance } from '@/hooks/use-appearance'
import { useAudioSettings } from '@/hooks/use-audio-settings'
import { useEngine } from '@/hooks/use-engine'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { useGlossary } from '@/hooks/use-glossary'
import { usePluginSettings } from '@/hooks/use-plugin-settings'
import { useTranslateSettings } from '@/hooks/use-translate-settings'
import { useVoice } from '@/hooks/use-voice'
import { getAppSettings } from '@/lib/app-settings'
import { GENERAL_ID } from '@/lib/glossary'
import { audioSourceLabel } from '@/lib/audio'
import { isTauri } from '@/lib/engine'
import { describeRoute } from '@/lib/translation'

export default function App() {
  const asr = useAsrSettings()
  const translate = useTranslateSettings()
  const glossary = useGlossary()
  const audio = useAudioSettings()
  const general = useGeneralSettings()
  const voice = useVoice()
  const plugins = usePluginSettings()
  const appearance = useAppearance()
  const engine = useEngine({
    translateEnabled: translate.settings.enabled,
    onTranslationDone: (text) =>
      voice.speak(text, translate.settings.targetLang),
  })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>('general')
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [onboarded, setOnboarded] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.localStorage.getItem('sabir-onboarded') === '1',
  )
  const translateLabel = describeRoute(translate.settings)
  const asrReady = asr.ready
  const speechKind =
    asr.view?.models.find((model) => model.id === asr.view?.settings.model)
      ?.kind ?? null

  // Rust is the source of truth for the interface language; mirror it into
  // localStorage once on boot and reload if this window was built with the
  // other language.
  useEffect(() => {
    // In the browser preview localStorage alone is the source of truth; Rust
    // only speaks on the Tauri side.
    if (!isTauri()) return
    let alive = true
    void getAppSettings().then((settings) => {
      if (!alive || settings.locale === currentLocale()) return
      setLocale(settings.locale)
      window.location.reload()
    })
    return () => {
      alive = false
    }
  }, [])

  const { state, start, stop, pause, resume } = engine

  // Voiceover only runs while the engine is producing captions.
  useEffect(() => {
    if (engine.state !== 'listening' && engine.state !== 'starting') {
      voice.stop()
    }
  }, [engine.state, voice.stop])

  useEffect(() => () => voice.stop(), [voice.stop])

  const audioLocked =
    state === 'listening' || state === 'starting' || state === 'paused'
  const pinned = general.settings.alwaysOnTop

  function togglePin() {
    general.update({ alwaysOnTop: !pinned })
  }

  function openSettings(section: SettingsSection = 'general') {
    setSettingsSection(section)
    setSettingsOpen(true)
  }

  function handleGeneralSaved(result: GeneralSaveResult) {
    general.replace(result.general)
    if (result.audio) audio.setSettings(result.audio)
    if (result.asr) asr.setView(result.asr)
    if (result.translate) translate.setView(result.translate)
  }

  const toggleRecording = useCallback(() => {
    if (state === 'listening' || state === 'starting') {
      stop()
    } else if (state === 'paused') {
      resume()
    } else if (asrReady) {
      void start()
    } else {
      setSettingsSection('recognition')
      setSettingsOpen(true)
    }
  }, [state, asrReady, start, stop, resume])

  const togglePause = useCallback(() => {
    if (state === 'listening') {
      pause()
    } else if (state === 'paused') {
      resume()
    }
  }, [state, pause, resume])

  const floatActive =
    general.settings.floatEnabled &&
    (state === 'starting' || state === 'listening' || state === 'paused')

  useEffect(() => {
    if (!isTauri()) return
    void invoke('set_float_visible', { visible: floatActive }).catch(() => {})
  }, [floatActive])

  // The overlay is only visible while a session is running, so it never
  // covers the screen when the app is idle. Toggling the preference on mid-
  // session shows it at once; dismissing it from the overlay itself turns the
  // preference off, which hides it here.
  const captionActive =
    general.settings.captionEnabled &&
    (state === 'starting' || state === 'listening' || state === 'paused')

  useEffect(() => {
    if (!isTauri()) return
    // Both windows share localStorage, so the main window can hand Rust the
    // spot the overlay was last dragged to.
    let spot: { x: number; y: number } | null = null
    try {
      const raw = window.localStorage.getItem('sabir-overlay-pos')
      if (raw) {
        const saved = JSON.parse(raw) as { x?: unknown; y?: unknown }
        if (typeof saved.x === 'number' && typeof saved.y === 'number') {
          spot = { x: Math.round(saved.x), y: Math.round(saved.y) }
        }
      }
    } catch {
      // Corrupt position: let Rust use the default spot.
    }
    void invoke('set_caption_visible', { visible: captionActive, spot }).catch(
      () => {},
    )
  }, [captionActive])

  const floatSource = engine.source
    ? localize(engine.source)
    : audioSourceLabel(audio.settings.source)

  useEffect(() => {
    if (!isTauri()) return
    void emit('sabir:float-status', {
      state,
      elapsedMs: engine.elapsedMs,
      source: floatSource,
    }).catch(() => {})
  }, [state, engine.elapsedMs, floatSource])

  // The subtitle overlay lives in its own window; it only needs the last two
  // lines so each partial update stays a few hundred bytes.
  useEffect(() => {
    if (!isTauri()) return
    const lines: CaptionLine[] = engine.finals.slice(-2).map((segment) => {
      const translation = engine.translations[segment.id]
      return {
        id: segment.id,
        text: segment.text,
        translation: translation?.text.trim() ? translation.text : null,
      }
    })
    const payload: CaptionState = {
      state,
      source: floatSource,
      interim: engine.interim?.text ?? null,
      lines,
    }
    void emit('sabir:caption-state', payload).catch(() => {})
  }, [
    state,
    floatSource,
    engine.finals,
    engine.interim,
    engine.translations,
  ])

  // Dismissed from the overlay itself (or Alt+F4 on it): switch it back off.
  useEffect(() => {
    if (!isTauri()) return
    const dismiss = () => general.update({ captionEnabled: false })
    const unlistenDismiss = listen('sabir:caption-dismiss', dismiss)
    const unlistenHidden = listen('sabir:caption-hidden', dismiss)
    return () => {
      void unlistenDismiss.then((fn) => fn())
      void unlistenHidden.then((fn) => fn())
    }
  }, [general.update])

  useEffect(() => {
    if (!isTauri()) return
    const unlisten = listen<string>('sabir:command', (event) => {
      switch (event.payload) {
        case 'toggle':
          toggleRecording()
          break
        case 'pause':
          togglePause()
          break
        case 'settings':
          setSettingsSection('general')
          setSettingsOpen(true)
          void invoke('focus_main_window').catch(() => {})
          break
        default:
          void invoke('focus_main_window').catch(() => {})
      }
    })
    return () => {
      void unlisten.then((fn) => fn())
    }
  }, [toggleRecording, togglePause])

  useEffect(() => {
    if (!isTauri()) return
    const unlisten = listen<string>('sabir:float-action', (event) => {
      switch (event.payload) {
        case 'pause':
          pause()
          break
        case 'resume':
          resume()
          break
        case 'stop':
          stop()
          break
        default:
          void invoke('focus_main_window').catch(() => {})
      }
    })
    return () => {
      void unlisten.then((fn) => fn())
    }
  }, [pause, resume, stop])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const modifier = event.metaKey || event.ctrlKey
      if (modifier && event.key.toLowerCase() === 'm') {
        event.preventDefault()
        toggleRecording()
        return
      }
      if (modifier && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        togglePause()
        return
      }
      if (
        event.key === 'Escape' &&
        state !== 'idle' &&
        !settingsOpen &&
        !libraryOpen
      ) {
        stop()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggleRecording, togglePause, stop, state, settingsOpen, libraryOpen])

  return (
    <div className="lt-surface flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <TopBar
        theme={appearance.resolved}
        onToggleTheme={appearance.toggleMode}
        onOpenSettings={() => openSettings('general')}
        onOpenLibrary={() => setLibraryOpen(true)}
        onOpenAbout={() => openSettings('about')}
        pinned={pinned}
        onTogglePin={togglePin}
        isDemo={engine.isDemo}
        audioSource={audio.settings.source}
        audioProcessId={audio.settings.processId}
        audioLocked={audioLocked}
        onSelectAudioSource={(source) => void audio.update({ source })}
        onOpenAudioSettings={() => openSettings('recognition')}
      />

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          <TranscriptView
            finals={engine.finals}
            interim={engine.interim}
            translations={engine.translations}
            state={engine.state}
            onStart={() =>
              asrReady ? void engine.start() : openSettings('recognition')
            }
            onClear={engine.clear}
            onRetry={(id) => void engine.retryTranslation(id)}
            scenePresets={glossary.glossary.presets.map((preset) => ({
              id: preset.id,
              name:
                preset.id === GENERAL_ID
                  ? tr('通用（不限场景）')
                  : preset.name.trim() || tr("未命名场景"),
            }))}
            activeSceneId={glossary.glossary.activeId}
            onSelectScene={(id) => void glossary.setActive(id)}
            onManageScenes={() => openSettings('glossary')}
          />
          <ControlDock
            state={engine.state}
            source={
              engine.source
                ? localize(engine.source)
                : audioSourceLabel(audio.settings.source)
            }
            sampleRate={engine.sampleRate}
            level={engine.level}
            elapsedMs={engine.elapsedMs}
            message={engine.message}
            error={engine.error}
            asrReady={asrReady}
            translateEnabled={translate.settings.enabled}
            translateLabel={translateLabel}
            onStart={() =>
              asrReady ? void engine.start() : openSettings('recognition')
            }
            onStop={engine.stop}
            onPause={pause}
            onResume={resume}
            onOpenSettings={() => openSettings('translation')}
          />
        </main>

        <AskPanel
          finals={engine.finals}
          hasTranscript={engine.finals.length > 0}
          asrReady={asrReady}
          speechKind={speechKind}
          translateEnabled={translate.settings.enabled}
          translateLabel={translateLabel}
        />
      </div>

      <LibraryDialog open={libraryOpen} onOpenChange={setLibraryOpen} />

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        initialSection={settingsSection}
        general={general.settings}
        audio={audio.settings}
        asrView={asr.view}
        translateView={translate.view}
        onGeneralSaved={handleGeneralSaved}
        onAsrReload={asr.reload}
        onAsrSaved={asr.setView}
        onTranslateReload={translate.reload}
        onTranslateSaved={translate.setView}
        onGlossarySaved={glossary.setGlossary}
        onAudioSaved={audio.setSettings}
        appearance={appearance.appearance}
        resolvedMode={appearance.resolved}
        onAppearanceChange={appearance.update}
        onSelectTheme={appearance.selectTheme}
        voiceView={voice.view}
        onVoiceReload={voice.reload}
        onVoiceSaved={voice.setView}
        pluginView={plugins.view}
        onPluginReload={plugins.reload}
        onPluginSaved={plugins.setView}
      />

      {!onboarded && (
        <Onboarding
          asrView={asr.view}
          audio={audio.settings}
          onAudioSaved={audio.setSettings}
          onAsrSaved={asr.setView}
          onComplete={() => setOnboarded(true)}
        />
      )}
    </div>
  )
}
