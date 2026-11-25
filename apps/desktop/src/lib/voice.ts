import { tr } from '@/lib/i18n'
/**
 * Bridge to the local voiceover model (Kokoro v1.1, Chinese + English).
 *
 * Rust downloads and runs the model; the WebView only sees sizes, paths and a
 * base64 WAV. In the browser preview the same shapes come from memory and the
 * hook speaks with the browser's own voice instead.
 */

import { Channel, invoke } from '@tauri-apps/api/core'
import { isTauri } from './engine'

export type VoiceSettings = {
  enabled: boolean
}

export type VoiceModelInfo = {
  id: string
  title: string
  note: string
  bytes: number
  installed: boolean
  downloading: boolean
  dir: string
}

export type VoiceSettingsView = {
  settings: VoiceSettings
  model: VoiceModelInfo
  modelsRoot: string
}

export type VoiceDownloadEvent =
  | {
      type: 'progress'
      file: string
      fileIndex: number
      fileTotal: number
      downloaded: number
      total: number
    }
  | { type: 'done'; dir: string }
  | { type: 'error'; message: string }
  | { type: 'cancelled' }

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = { enabled: false }

let demoView: VoiceSettingsView = {
  settings: { ...DEFAULT_VOICE_SETTINGS },
  model: {
    id: 'kokoro-zh-en-v1.1',
    title: tr("Kokoro v1.1 · 中英双语"),
    note: tr(
      "在本机运行，不上传任何内容。支持中文和英文；RSI 这类短缩写会拆成字母朗读，词典里没有的其他英文单词会被跳过。",
    ),
    bytes: 387430323,
    installed: true,
    downloading: false,
    dir: '/demo/models/tts/kokoro-zh-en-v1.1',
  },
  modelsRoot: '/demo/models/tts',
}

let demoTimer: number | null = null
let demoCancel: ((event: VoiceDownloadEvent) => void) | null = null

function cloneDemo(): VoiceSettingsView {
  return JSON.parse(JSON.stringify(demoView)) as VoiceSettingsView
}

export async function getVoiceSettings(): Promise<VoiceSettingsView> {
  if (!isTauri()) return cloneDemo()
  return invoke<VoiceSettingsView>('get_voice_settings')
}

export async function saveVoiceSettings(
  settings: VoiceSettings,
): Promise<VoiceSettingsView> {
  if (!isTauri()) {
    if (settings.enabled && !demoView.model.installed) {
      throw new Error(tr("先下载上面的语音模型，才能打开朗读。"))
    }
    demoView = { ...cloneDemo(), settings: { ...settings } }
    return cloneDemo()
  }
  return invoke<VoiceSettingsView>('save_voice_settings', { settings })
}

export async function downloadVoiceModel(
  onEvent: (event: VoiceDownloadEvent) => void,
): Promise<void> {
  if (!isTauri()) {
    demoDownload(onEvent)
    return
  }
  const channel = new Channel<VoiceDownloadEvent>()
  channel.onmessage = onEvent
  await invoke('download_voice_model', { channel })
}

export function cancelVoiceDownload(): void {
  if (!isTauri()) {
    if (demoTimer !== null) {
      window.clearInterval(demoTimer)
      demoTimer = null
    }
    demoView.model.downloading = false
    demoCancel?.({ type: 'cancelled' })
    demoCancel = null
    return
  }
  void invoke('cancel_voice_download')
}

export async function deleteVoiceModel(): Promise<VoiceSettingsView> {
  if (!isTauri()) {
    demoView.model.installed = false
    demoView.model.downloading = false
    demoView.settings = { ...DEFAULT_VOICE_SETTINGS }
    return cloneDemo()
  }
  return invoke<VoiceSettingsView>('delete_voice_model')
}

/**
 * Synthesise one sentence. Resolves to a base64 WAV; in the browser preview it
 * resolves to an empty string and `use-voice` falls back to the Web Speech API.
 */
export async function synthesizeVoice(
  text: string,
  lang: string,
): Promise<string> {
  if (!isTauri()) return ''
  return invoke<string>('synthesize_voice', { text, lang })
}

function demoDownload(onEvent: (event: VoiceDownloadEvent) => void) {
  if (demoView.model.downloading) return
  demoView.model.downloading = true
  const total = demoView.model.bytes
  let downloaded = 0
  demoCancel = onEvent
  onEvent({
    type: 'progress',
    file: 'model.onnx',
    fileIndex: 0,
    fileTotal: 5,
    downloaded,
    total,
  })
  demoTimer = window.setInterval(() => {
    downloaded = Math.min(total, downloaded + total / 8)
    onEvent({
      type: 'progress',
      file: 'model.onnx',
      fileIndex: 0,
      fileTotal: 5,
      downloaded,
      total,
    })
    if (downloaded >= total) {
      if (demoTimer !== null) window.clearInterval(demoTimer)
      demoTimer = null
      demoCancel = null
      demoView.model.downloading = false
      demoView.model.installed = true
      onEvent({ type: 'done', dir: demoView.model.dir })
    }
  }, 300)
}
