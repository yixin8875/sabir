import { tr } from '@/lib/i18n'
/**
 * Bridge to the recognition model manager.
 *
 * Weights are downloaded by Rust into the app data directory; the WebView only
 * sees progress numbers and paths. In a plain browser preview the same shapes
 * are served from a demo catalogue.
 */

import { Channel, invoke } from '@tauri-apps/api/core'
import { isTauri } from './engine'

export type AsrModelKind = 'streaming' | 'whisper'

export type AsrModelInfo = {
  id: string
  title: string
  note: string
  bytes: number
  recommended: boolean
  kind: AsrModelKind
  installed: boolean
  downloading: boolean
  dir: string
}

export type AsrSettings = {
  model: string | null
  language: string
  threads: number
  modelsRoot: string | null
}

export type AsrSettingsView = {
  settings: AsrSettings
  models: AsrModelInfo[]
  selectedDir: string | null
  modelsRoot: string
  ready: boolean
}

export type AsrDownloadEvent =
  | {
      type: 'progress'
      modelId: string
      file: string
      fileIndex: number
      fileTotal: number
      downloaded: number
      total: number
    }
  | { type: 'done'; modelId: string; dir: string }
  | { type: 'error'; modelId: string; message: string }
  | { type: 'cancelled'; modelId: string }

export const DEFAULT_ASR_SETTINGS: AsrSettings = {
  model: null,
  language: 'auto',
  threads: 2,
  modelsRoot: null,
}

let demoView: AsrSettingsView = {
  settings: { ...DEFAULT_ASR_SETTINGS, model: 'bilingual-zh-en' },
  models: [
    {
      id: 'bilingual-zh-en',
      title: tr("中英双语 Zipformer"),
      note: tr("边说边出字，中英文自动混识，通用场景首选。"),
      bytes: 199056205,
      recommended: true,
      kind: 'streaming',
      installed: true,
      downloading: false,
      dir: '/demo/models/asr/bilingual-zh-en',
    },
    {
      id: 'en-streaming',
      title: tr("英文 Zipformer"),
      note: tr("只识别英文，体积更小、延迟更低，适合纯英文课程。"),
      bytes: 72654256,
      recommended: false,
      kind: 'streaming',
      installed: false,
      downloading: false,
      dir: '/demo/models/asr/en-streaming',
    },
    {
      id: 'zh-14m',
      title: tr("中文轻量 Zipformer"),
      note: tr("低配电脑或只看中文会议时用，占内存最少。"),
      bytes: 30975688,
      recommended: false,
      kind: 'streaming',
      installed: false,
      downloading: false,
      dir: '/demo/models/asr/zh-14m',
    },
    {
      id: 'whisper-turbo',
      title: 'Whisper Large v3 Turbo',
      note: tr("整段识别：说完整句、停顿片刻后出字，中英混说和多语种准确率最高。体积约 1 GB，CPU 解码每句再花约一秒。"),
      bytes: 1036613791,
      recommended: false,
      kind: 'whisper',
      installed: false,
      downloading: false,
      dir: '/demo/models/asr/whisper-turbo',
    },
    {
      id: 'whisper-small',
      title: 'Whisper Small',
      note: tr("整段识别，轻量多语种模型，下载和内存占用都小，准确率低于 Turbo。"),
      bytes: 375485327,
      recommended: false,
      kind: 'whisper',
      installed: false,
      downloading: false,
      dir: '/demo/models/asr/whisper-small',
    },
  ],
  selectedDir: '/demo/models/asr/bilingual-zh-en',
  modelsRoot: '/demo/models/asr',
  ready: true,
}

function cloneDemo(): AsrSettingsView {
  return structuredClone(demoView)
}

export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return mb >= 1000 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(0)} MB`
}

export function selectedModelId(view: AsrSettingsView | null): string {
  if (!view) return ''
  const value = view.settings.model
  if (value && view.models.some((model) => model.id === value)) return value
  return value ? 'custom' : ''
}

export async function getAsrSettings(): Promise<AsrSettingsView> {
  if (!isTauri()) return cloneDemo()
  return invoke<AsrSettingsView>('get_asr_settings')
}

export async function listAsrModels(): Promise<AsrSettingsView> {
  if (!isTauri()) return cloneDemo()
  return invoke<AsrSettingsView>('list_asr_models')
}

export async function saveAsrSettings(settings: AsrSettings) {
  if (!isTauri()) {
    // Mirror Rust: the recommended model follows the recognition language.
    const recommended = settings.language === 'en' ? 'en-streaming' : 'bilingual-zh-en'
    demoView = {
      ...demoView,
      settings,
      models: demoView.models.map((model) => ({
        ...model,
        recommended: model.id === recommended,
      })),
    }
    if (settings.model === null) {
      demoView.selectedDir = null
      demoView.ready = false
    }
    return cloneDemo()
  }
  return invoke<AsrSettingsView>('save_asr_settings', { settings })
}

export async function downloadAsrModel(
  modelId: string,
  onEvent: (event: AsrDownloadEvent) => void,
): Promise<void> {
  if (!isTauri()) {
    simulateDownload(modelId, onEvent)
    return
  }
  const channel = new Channel<AsrDownloadEvent>()
  channel.onmessage = onEvent
  await invoke('download_asr_model', { modelId, channel })
}

export async function cancelAsrDownload(modelId: string): Promise<void> {
  if (!isTauri()) return
  await invoke('cancel_asr_download', { modelId })
}

export async function deleteAsrModel(modelId: string): Promise<AsrSettingsView> {
  if (!isTauri()) {
    demoView = {
      ...demoView,
      models: demoView.models.map((model) =>
        model.id === modelId ? { ...model, installed: false } : model,
      ),
    }
    if (demoView.settings.model === modelId) {
      demoView.settings = { ...demoView.settings, model: null }
      demoView.selectedDir = null
      demoView.ready = false
    }
    return cloneDemo()
  }
  return invoke<AsrSettingsView>('delete_asr_model', { modelId })
}

export async function browseModelDir(): Promise<string | null> {
  if (!isTauri()) return null
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({
    directory: true,
    multiple: false,
    title: tr(
      '选择识别模型目录（Zipformer：encoder/decoder/joiner/tokens.txt；Whisper：encoder/decoder/*-tokens.txt）',
    ),
  })
  return typeof picked === 'string' ? picked : null
}

function simulateDownload(
  modelId: string,
  onEvent: (event: AsrDownloadEvent) => void,
) {
  const model = demoView.models.find((item) => item.id === modelId)
  if (!model) return
  const steps = 24
  let step = 0
  const timer = window.setInterval(() => {
    step += 1
    onEvent({
      type: 'progress',
      modelId,
      file: 'encoder.int8.onnx',
      fileIndex: 0,
      fileTotal: 4,
      downloaded: Math.round((model.bytes * step) / steps),
      total: model.bytes,
    })
    if (step < steps) return
    window.clearInterval(timer)
    demoView = {
      ...demoView,
      models: demoView.models.map((item) =>
        item.id === modelId ? { ...item, installed: true } : item,
      ),
    }
    onEvent({ type: 'done', modelId, dir: model.dir })
  }, 90)
}
