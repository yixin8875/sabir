import { tr } from '@/lib/i18n'
/**
 * Bridge to the Rust translation router.
 *
 * Audio never crosses this boundary; only finished sentences do. Settings are
 * persisted in Rust (settings.json + OS keyring for the API key), so the
 * WebView only ever reads a redacted view.
 */

import { Channel, invoke } from '@tauri-apps/api/core'
import { isTauri } from './engine'
import { downloadJsonFile, pickJsonFile } from './portable-file'

export type TranslateRoute = 'nmt' | 'localLlm' | 'remoteLlm'

export type EndpointSettings = {
  name: string
  baseUrl: string
  model: string
}

export type ProviderProfile = {
  id: string
  name: string
  baseUrl: string
  model: string
  consentAt: string | null
}

export type TargetLang = 'zh-Hans' | 'zh-Hant' | 'en'

export type TranslateSettings = {
  enabled: boolean
  route: TranslateRoute
  contextLines: number
  fallbackToLocal: boolean
  localLlm: EndpointSettings
  providers: ProviderProfile[]
  activeProviderId: string
  modelsRoot: string | null
  targetLang: TargetLang
}

export type TranslateSettingsView = {
  settings: TranslateSettings
  /** Which provider ids already have a key in the OS keyring. */
  providerKeys: Record<string, boolean>
  nmtInstalled: boolean
  nmtDir: string
  nmtRoot: string
  nmtDownloading: boolean
  nmtBytes: number
}

export const DEFAULT_PROVIDER: ProviderProfile = {
  id: 'deepseek',
  name: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  consentAt: null,
}

export const MAX_PROVIDERS = 10
export const MAX_PROVIDER_NAME = 40

export function activeProvider(
  settings: TranslateSettings,
): ProviderProfile | undefined {
  return (
    settings.providers.find(
      (provider) => provider.id === settings.activeProviderId,
    ) ?? settings.providers[0]
  )
}

export type TranslateDownloadEvent =
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

export const NMT_MODEL = {
  title: tr("本地 NMT · opus-mt en→zh"),
  note: tr("逐句英文转简体中文，完全离线，几百毫秒到两秒一句。"),
  bytes: 441177157,
}

export type TestTranslation = {
  text: string
  route: string
  provider?: string | null
  ms: number
}

export const DEFAULT_TRANSLATE_SETTINGS: TranslateSettings = {
  enabled: true,
  route: 'nmt',
  contextLines: 4,
  fallbackToLocal: true,
  localLlm: {
    name: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:3b',
  },
  providers: [structuredClone(DEFAULT_PROVIDER)],
  activeProviderId: DEFAULT_PROVIDER.id,
  modelsRoot: null,
  targetLang: 'zh-Hans',
}

let demoView: TranslateSettingsView = {
  settings: structuredClone(DEFAULT_TRANSLATE_SETTINGS),
  providerKeys: {},
  nmtInstalled: false,
  nmtDir: '/demo/models/translate/en-zh',
  nmtRoot: '/demo/models/translate',
  nmtDownloading: false,
  nmtBytes: NMT_MODEL.bytes,
}

export function routeLabel(route: string | undefined): string {
  switch (route) {
    case 'nmt':
      return tr("本地 NMT")
    case 'localLlm':
      return tr("本地 LLM")
    case 'remoteLlm':
      return tr("第三方")
    case 'passthrough':
      return tr("已是中文")
    default:
      return tr("未翻译")
  }
}

export function describeRoute(settings: TranslateSettings): string {
  switch (settings.route) {
    case 'nmt':
      return tr("本地 NMT · en→zh")
    case 'localLlm':
      return settings.localLlm.name || settings.localLlm.model || tr("本地 LLM")
    case 'remoteLlm': {
      const provider = activeProvider(settings)
      return provider?.name || provider?.model || tr("第三方")
    }
  }
}

export async function getTranslateSettings(): Promise<TranslateSettingsView> {
  if (!isTauri()) return structuredClone(demoView)
  return invoke<TranslateSettingsView>('get_translate_settings')
}

export async function saveTranslateSettings(input: {
  settings: TranslateSettings
  apiKey?: string
  consent: boolean
}): Promise<TranslateSettingsView> {
  if (!isTauri()) {
    const settings = structuredClone(input.settings)
    if (input.consent) {
      const provider = activeProvider(settings)
      if (provider && !provider.consentAt) {
        provider.consentAt = `1:${Math.floor(Date.now() / 1000)}`
      }
    }
    demoView = { ...demoView, settings }
    if (input.apiKey) {
      demoView.providerKeys = {
        ...demoView.providerKeys,
        [settings.activeProviderId]: true,
      }
    }
    if (input.settings.modelsRoot) {
      demoView.nmtRoot = input.settings.modelsRoot
      demoView.nmtDir = `${input.settings.modelsRoot}/en-zh`
    }
    return structuredClone(demoView)
  }
  return invoke<TranslateSettingsView>('save_translate_settings', {
    settings: input.settings,
    apiKey: input.apiKey,
    consent: input.consent,
  })
}

export async function clearProviderApiKey(
  providerId: string,
): Promise<TranslateSettingsView> {
  if (!isTauri()) {
    const providerKeys = { ...demoView.providerKeys }
    delete providerKeys[providerId]
    demoView = { ...demoView, providerKeys }
    return structuredClone(demoView)
  }
  return invoke<TranslateSettingsView>('clear_provider_api_key', {
    providerId,
  })
}

const PORTABLE_PROVIDERS_FILE = 'livetrans-providers.json'

/**
 * Write configured profiles to a shared JSON file without keys, consent or
 * ids. Returns the path in the app, `null` in the browser preview (download).
 */
export async function exportProviderProfilesFile(
  profiles: ProviderProfile[],
): Promise<string | null> {
  const portable = profiles
    .filter(
      (profile) => profile.baseUrl.trim() && profile.model.trim(),
    )
    .map((profile) => ({
      name: profile.name.trim(),
      baseUrl: profile.baseUrl.trim(),
      model: profile.model.trim(),
    }))
  if (portable.length === 0) {
    throw new Error(tr('没有可导出的配置档：先填写接口地址与模型。'))
  }
  if (!isTauri()) {
    downloadJsonFile(PORTABLE_PROVIDERS_FILE, {
      app: 'livetrans',
      kind: 'provider-profiles',
      version: 1,
      profiles: portable,
    })
    return null
  }
  const { save } = await import('@tauri-apps/plugin-dialog')
  const path = await save({
    defaultPath: PORTABLE_PROVIDERS_FILE,
    filters: [{ name: 'JSON', extensions: ['json'] }],
    title: tr('导出 Provider 配置档'),
  })
  if (!path) return null
  return invoke<string>('export_provider_profiles', { path, profiles })
}

/**
 * Read a shared provider file. Profiles come back with empty ids and no
 * consent; the page assigns ids and the user re-enters keys and consents.
 */
export async function importProviderProfilesFile(): Promise<
  ProviderProfile[] | null
> {
  if (!isTauri()) return importDemoProviders()
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({
    directory: false,
    multiple: false,
    filters: [{ name: 'JSON', extensions: ['json'] }],
    title: tr('选择 Provider 配置文件'),
  })
  if (typeof picked !== 'string') return null
  return invoke<ProviderProfile[]>('import_provider_profiles', {
    path: picked,
  })
}

async function importDemoProviders(): Promise<ProviderProfile[] | null> {
  const raw = await pickJsonFile()
  if (raw === null) return null
  const document = raw as { profiles?: unknown }
  const items = Array.isArray(document?.profiles) ? document.profiles : []
  const profiles: ProviderProfile[] = []
  for (const item of items) {
    if (profiles.length >= MAX_PROVIDERS) break
    if (typeof item !== 'object' || item === null) continue
    const record = item as {
      name?: unknown
      baseUrl?: unknown
      model?: unknown
    }
    const baseUrl =
      typeof record.baseUrl === 'string' ? record.baseUrl.trim() : ''
    const model = typeof record.model === 'string' ? record.model.trim() : ''
    if (!baseUrl || !model) continue
    const name =
      typeof record.name === 'string'
        ? record.name.trim().slice(0, MAX_PROVIDER_NAME)
        : ''
    profiles.push({
      id: '',
      name: name || tr('服务商 {n}', { n: profiles.length + 1 }),
      baseUrl,
      model,
      consentAt: null,
    })
  }
  if (profiles.length === 0) {
    throw new Error(
      tr('文件里没有完整的配置档（需要接口地址与模型）。'),
    )
  }
  return profiles
}

export async function downloadTranslateModel(
  onEvent: (event: TranslateDownloadEvent) => void,
): Promise<void> {
  if (!isTauri()) {
    simulateDownload(onEvent)
    return
  }
  const channel = new Channel<TranslateDownloadEvent>()
  channel.onmessage = onEvent
  await invoke('download_translate_model', { channel })
}

export async function cancelTranslateDownload(): Promise<void> {
  if (!isTauri()) return
  await invoke('cancel_translate_download')
}

export async function deleteTranslateModel(): Promise<TranslateSettingsView> {
  if (!isTauri()) {
    demoView = { ...demoView, nmtInstalled: false }
    return structuredClone(demoView)
  }
  return invoke<TranslateSettingsView>('delete_translate_model')
}

export async function browseTranslateDir(): Promise<string | null> {
  if (!isTauri()) return null
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({
    directory: true,
    multiple: false,
    title: tr("选择翻译模型存放目录（本地 NMT 会下载到该目录下的 en-zh）"),
  })
  return typeof picked === 'string' ? picked : null
}

function simulateDownload(onEvent: (event: TranslateDownloadEvent) => void) {
  let step = 0
  const steps = 26
  const timer = window.setInterval(() => {
    step += 1
    onEvent({
      type: 'progress',
      file: 'decoder_model_int8.onnx',
      fileIndex: 1,
      fileTotal: 5,
      downloaded: Math.round((NMT_MODEL.bytes * step) / steps),
      total: NMT_MODEL.bytes,
    })
    if (step < steps) return
    window.clearInterval(timer)
    demoView = { ...demoView, nmtInstalled: true }
    onEvent({ type: 'done', dir: demoView.nmtDir })
  }, 90)
}

export async function testTranslation(route?: TranslateRoute): Promise<TestTranslation> {
  if (!isTauri()) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    return {
      text: tr("早上好，各位。我们开始今天的课程。"),
      route: route ?? 'nmt',
      provider: null,
      ms: 300,
    }
  }
  return invoke<TestTranslation>('test_translation', { route })
}
