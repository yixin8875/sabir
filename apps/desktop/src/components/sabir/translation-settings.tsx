import { tr } from '@/lib/i18n'
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from 'react'
import {
  Cloud,
  Cpu,
  Download,
  FolderOpen,
  HardDrive,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { Switch } from '@/components/ui/switch'
import { formatBytes } from '@/lib/asr'
import { isTauri } from '@/lib/engine'
import {
  activeProvider,
  browseTranslateDir,
  cancelTranslateDownload,
  clearProviderApiKey,
  DEFAULT_TRANSLATE_SETTINGS,
  deleteTranslateModel,
  downloadTranslateModel,
  exportProviderProfilesFile,
  importProviderProfilesFile,
  MAX_PROVIDER_NAME,
  MAX_PROVIDERS,
  NMT_MODEL,
  saveTranslateSettings,
  testTranslation,
  type EndpointSettings,
  type ProviderProfile,
  type TargetLang,
  type TestTranslation,
  type TranslateRoute,
  type TranslateSettings,
  type TranslateSettingsView,
} from '@/lib/translation'
import type { SettingsPanelHandle } from './recognition-settings'
import { probeEnvironment, type Environment } from '@/lib/environment'
import { cn } from '@/lib/utils'

const ROUTES: {
  id: TranslateRoute
  title: string
  note: string
  icon: typeof Cpu
}[] = [
  {
    id: 'nmt',
    title: tr("本地 NMT"),
    note: tr("opus-mt en→zh，下载后完全离线，几百毫秒到两秒一句。"),
    icon: HardDrive,
  },
  {
    id: 'localLlm',
    title: tr("本地 LLM"),
    note: tr("连接本机 Ollama / LM Studio / llama.cpp，译文更顺，需要已下载模型。"),
    icon: Cpu,
  },
  {
    id: 'remoteLlm',
    title: tr("第三方"),
    note: tr("任意 OpenAI 兼容服务，用你自己的 Key，仅在授权后发送句子文本。"),
    icon: Cloud,
  },
]

const LOCAL_PRESETS: { name: string; baseUrl: string; model: string }[] = [
  { name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:3b' },
  { name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model' },
]

const REMOTE_PRESETS: { name: string; baseUrl: string; model: string }[] = [
  {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
  {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
  },
]

const TARGETS: { value: TargetLang; label: string }[] = [
  { value: 'zh-Hans', label: tr("简体中文") },
  { value: 'zh-Hant', label: tr("繁体中文") },
  { value: 'en', label: tr("英文") },
]

type DownloadState = {
  downloaded: number
  total: number
  file: string
  error: string | null
}

type TranslationSettingsProps = {
  view: TranslateSettingsView | null
  onReload: () => Promise<void>
  onSaved: (view: TranslateSettingsView) => void
  onDirtyChange: (dirty: boolean) => void
  ref?: Ref<SettingsPanelHandle>
}

export function TranslationSettings({
  view,
  onReload,
  onSaved,
  onDirtyChange,
  ref,
}: TranslationSettingsProps) {
  const [form, setForm] = useState<TranslateSettings>(
    view?.settings ?? DEFAULT_TRANSLATE_SETTINGS,
  )
  const [apiKey, setApiKey] = useState('')
  const [consent, setConsent] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestTranslation | null>(null)
  const [download, setDownload] = useState<DownloadState | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmDeleteProfile, setConfirmDeleteProfile] = useState<
    string | null
  >(null)
  const [rescanning, setRescanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [profileNote, setProfileNote] = useState<string | null>(null)
  const [environment, setEnvironment] = useState<Environment | null>(null)
  const currentProvider = activeProvider(form)
  const currentKeySet = currentProvider
    ? Boolean(view?.providerKeys?.[currentProvider.id])
    : false

  useEffect(() => {
    void probeEnvironment()
      .then(setEnvironment)
      .catch(() => {})
  }, [])

  const formRef = useRef(form)
  formRef.current = form

  const settingsKey = view ? JSON.stringify(view.settings) : ''
  useEffect(() => {
    if (!view) return
    setForm(view.settings)
    setApiKey('')
    setConsent(false)
    setTestResult(null)
    setError(null)
    setProfileNote(null)
    setConfirmDeleteProfile(null)
  }, [settingsKey, view])

  useEffect(() => {
    onDirtyChange(
      JSON.stringify(form) !== settingsKey || apiKey.length > 0 || consent,
    )
  }, [form, settingsKey, apiKey, consent, onDirtyChange])

  const needsConsent =
    form.route === 'remoteLlm' &&
    Boolean(currentProvider) &&
    !currentProvider?.consentAt &&
    !consent

  function patch(update: Partial<TranslateSettings>) {
    setForm((current) => ({ ...current, ...update }))
  }

  function patchEndpoint(update: Partial<EndpointSettings>) {
    setForm((current) => ({
      ...current,
      localLlm: { ...current.localLlm, ...update },
    }))
  }

  function patchProvider(update: Partial<ProviderProfile>) {
    if (!currentProvider) return
    setForm((current) => ({
      ...current,
      providers: current.providers.map((provider) =>
        provider.id === currentProvider.id
          ? { ...provider, ...update }
          : provider,
      ),
    }))
  }

  function selectProvider(id: string) {
    if (id === form.activeProviderId) return
    patch({ activeProviderId: id })
    setApiKey('')
    setConsent(false)
    setTestResult(null)
    setConfirmDeleteProfile(null)
  }

  function addProvider(preset?: { name: string; baseUrl: string; model: string }) {
    setForm((current) => {
      if (current.providers.length >= MAX_PROVIDERS) return current
      const id = `provider-${Date.now().toString(36)}-${current.providers.length + 1}`
      const profile: ProviderProfile = {
        id,
        name:
          preset?.name ??
          tr('服务商 {n}', { n: current.providers.length + 1 }),
        baseUrl: preset?.baseUrl ?? '',
        model: preset?.model ?? '',
        consentAt: null,
      }
      return {
        ...current,
        providers: [...current.providers, profile],
        activeProviderId: id,
      }
    })
    setApiKey('')
    setConsent(false)
    setTestResult(null)
    setConfirmDeleteProfile(null)
  }

  function removeProvider(id: string) {
    if (confirmDeleteProfile !== id) {
      setConfirmDeleteProfile(id)
      return
    }
    setConfirmDeleteProfile(null)
    setForm((current) => {
      if (current.providers.length <= 1) return current
      const index = current.providers.findIndex((provider) => provider.id === id)
      const providers = current.providers.filter(
        (provider) => provider.id !== id,
      )
      const activeProviderId =
        current.activeProviderId === id
          ? (providers[Math.min(Math.max(index, 0), providers.length - 1)]?.id ??
            providers[0].id)
          : current.activeProviderId
      return { ...current, providers, activeProviderId }
    })
    setApiKey('')
    setConsent(false)
    setTestResult(null)
  }

  async function exportProfiles() {
    setError(null)
    setProfileNote(null)
    try {
      const path = await exportProviderProfilesFile(form.providers)
      if (path) setProfileNote(tr('已导出：{path}', { path }))
      else if (!isTauri()) setProfileNote(tr('浏览器预览：已生成下载文件。'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function importProfiles() {
    setError(null)
    setProfileNote(null)
    const room = MAX_PROVIDERS - form.providers.length
    if (room <= 0) {
      setError(
        tr('配置档已达上限（{n}），先删除一些再导入。', { n: MAX_PROVIDERS }),
      )
      return
    }
    try {
      const incoming = await importProviderProfilesFile()
      if (!incoming || incoming.length === 0) return
      const used = new Set(form.providers.map((profile) => profile.id))
      const stamp = Date.now().toString(36)
      const added: ProviderProfile[] = []
      for (const profile of incoming) {
        if (added.length >= room) break
        const base = `provider-import-${stamp}-${added.length + 1}`
        let id = base
        let suffix = 1
        while (used.has(id)) {
          suffix += 1
          id = `${base}-${suffix}`
        }
        used.add(id)
        added.push({ ...profile, id, consentAt: null })
      }
      if (added.length === 0) return
      setForm({
        ...form,
        providers: [...form.providers, ...added],
        activeProviderId: added[0].id,
      })
      setApiKey('')
      setConsent(false)
      setTestResult(null)
      setConfirmDeleteProfile(null)
      setProfileNote(
        incoming.length > added.length
          ? tr(
              '已加入 {n} 套配置档（其余超出 {max} 套上限）。保存后生效；Key 需重新填写。',
              { n: added.length, max: MAX_PROVIDERS },
            )
          : tr('已加入 {n} 套配置档。保存后生效；Key 需重新填写。', {
              n: added.length,
            }),
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function persist(): Promise<TranslateSettingsView> {
    // Saving the configuration itself never sends text, so it does not need
    // consent. Translation, Q&A and the connection test still refuse to call
    // the active profile without a stored consent.
    return saveTranslateSettings({
      settings: formRef.current,
      apiKey: apiKey.trim() ? apiKey.trim() : undefined,
      consent,
    })
  }

  async function save() {
    setError(null)
    try {
      const saved = await persist()
      onSaved(saved)
      setForm(saved.settings)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      throw cause
    }
  }

  useImperativeHandle(ref, () => ({ save }))

  async function handleTest() {
    if (needsConsent) {
      setError(tr("先在设置里勾选同意，才能用这个配置档测试发送。"))
      return
    }
    setTesting(true)
    setError(null)
    setTestResult(null)
    try {
      const saved = await persist()
      onSaved(saved)
      setTestResult(await testTranslation(form.route))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setTesting(false)
    }
  }

  async function handleRemoveKey() {
    if (!currentProvider) return
    try {
      const next = await clearProviderApiKey(currentProvider.id)
      onSaved(next)
      setApiKey('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function handleDownload() {
    setError(null)
    setConfirmDelete(false)
    setDownload({
      downloaded: 0,
      total: view?.nmtBytes ?? NMT_MODEL.bytes,
      file: '',
      error: null,
    })
    try {
      // Save first so the download lands in the directory shown here.
      const saved = await persist()
      onSaved(saved)
      setForm(saved.settings)
      await downloadTranslateModel((event) => {
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
        } else if (event.type === 'cancelled') {
          setDownload(null)
        } else {
          setDownload((current) => ({
            downloaded: current?.downloaded ?? 0,
            total: current?.total ?? NMT_MODEL.bytes,
            file: current?.file ?? '',
            error: event.message,
          }))
        }
      })
    } catch (cause) {
      setDownload(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    setConfirmDelete(false)
    setError(null)
    try {
      onSaved(await deleteTranslateModel())
      await onReload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function handleBrowse() {
    const dir = await browseTranslateDir()
    if (dir) patch({ modelsRoot: dir })
  }

  async function handleRescan() {
    setRescanning(true)
    try {
      await onReload()
    } finally {
      setRescanning(false)
    }
  }

  const busy = Boolean(download && !download.error)
  const percent =
    download && download.total > 0
      ? Math.min(100, Math.round((download.downloaded / download.total) * 100))
      : 0

  return (
    <div className="space-y-7">
      <p className="text-xs leading-5 text-muted-foreground">
        {tr("句子在静音处定稿后才翻译，前面的几句会作为上下文。音频与识别结果始终留在本机。")}
      </p>

      <section className="grid grid-cols-[minmax(0,16rem)_1fr] items-end gap-4">
        <div className="space-y-2">
          <Label>{tr("翻译成")}</Label>
          {form.route === 'nmt' ? (
            <div className="flex h-9 items-center rounded-lg border border-input bg-muted/40 px-3 text-sm text-foreground">
              {tr("简体中文")}
            </div>
          ) : (
            <Select
              value={form.targetLang}
              onValueChange={(value: string | null) => {
                if (!value) return
                patch({ targetLang: value as TargetLang })
              }}
              items={TARGETS.map((item) => ({
                value: item.value,
                label: item.label,
              }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {TARGETS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
          <p className="text-[11px] leading-5 text-muted-foreground">
            {form.route === 'nmt'
              ? tr("NMT 只支持译为简体中文，换语言请用 LLM 路线。")
              : tr("翻译提示词会写明这个目标语言。")}
          </p>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background p-3">
          <div>
            <p className="text-sm text-foreground">{tr("不翻译，只记录原文")}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {tr("关闭翻译后只保留原文；已有译文仍显示。")}
            </p>
          </div>
          <Switch
            checked={!form.enabled}
            onCheckedChange={(checked: boolean) =>
              patch({ enabled: !checked })
            }
            aria-label="Only keep the transcript"
          />
        </div>
      </section>

      <section className="space-y-2.5">
        <Label>{tr("翻译配置")}</Label>
        <div className="grid gap-2">
          {ROUTES.map((route) => {
            const active = form.route === route.id
            const Icon = route.icon
            return (
              <button
                key={route.id}
                type="button"
                onClick={() => patch({ route: route.id })}
                aria-pressed={active}
                className={cn(
                  'flex items-start gap-3 rounded-xl border p-3 text-left transition-[border-color,background-color]',
                  active
                    ? 'border-accent-foreground/40 bg-accent/60'
                    : 'border-border bg-background hover:bg-accent/30',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border',
                    active
                      ? 'border-accent-foreground/30 text-accent-foreground'
                      : 'border-border text-muted-foreground',
                  )}
                >
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                    {route.title}
                    {route.id === 'nmt' &&
                      (view?.nmtInstalled ? (
                        <Badge variant="success" size="sm">
                          {tr("已安装")}
                        </Badge>
                      ) : (
                        <Badge variant="warning" size="sm">
                          {tr("缺模型")}
                        </Badge>
                      ))}
                  </span>
                  <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                    {route.note}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </section>

      {form.route === 'nmt' && (
        <section className="space-y-3">
          <div className="divide-y divide-border rounded-xl border border-border bg-background">
            <div className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">
                      {NMT_MODEL.title}
                    </span>
                    {view?.nmtInstalled && (
                      <Badge variant="success" size="sm">
                        {tr("已安装")}
                      </Badge>
                    )}
                    {view?.nmtDownloading && !download && (
                      <Badge variant="secondary" size="sm">
                        {tr("下载中")}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {formatBytes(view?.nmtBytes ?? NMT_MODEL.bytes)} ·{' '}
                    {NMT_MODEL.note}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {busy ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void cancelTranslateDownload()}
                    >
                      {tr("取消")}
                    </Button>
                  ) : view?.nmtInstalled ? (
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
                    <Button size="sm" onClick={() => void handleDownload()}>
                      {tr("下载模型")}
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

            <div className="space-y-2 p-4">
              <Label htmlFor="translate-models-root">{tr("下载位置")}</Label>
              <div className="flex flex-wrap gap-2">
                <Input
                  id="translate-models-root"
                  className="min-w-56 flex-1 font-mono text-[11px]"
                  value={form.modelsRoot ?? ''}
                  onChange={(event) =>
                    patch({ modelsRoot: event.target.value.trim() || null })
                  }
                  placeholder={view?.nmtRoot ?? tr("应用数据目录")}
                  spellCheck={false}
                />
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
                  {tr("重新扫描")}
                </Button>
              </div>
              <p className="break-all text-[11px] leading-5 text-muted-foreground">
                {tr('当前模型：{path}；下载前会先保存这个位置。', {
                  path: view?.nmtDir ?? '—',
                })}
              </p>
            </div>
          </div>
        </section>
      )}

      {form.route === 'localLlm' && (
        <section className="space-y-3">
          <Label>{tr("快速填写")}</Label>
          <div className="flex flex-wrap gap-2">
            {LOCAL_PRESETS.map((preset) => (
              <Button
                key={preset.name}
                variant="outline"
                size="sm"
                onClick={() => patchEndpoint(preset)}
              >
                {preset.name}
              </Button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="local-name">{tr("名称")}</Label>
              <Input
                id="local-name"
                value={form.localLlm.name}
                onChange={(event) =>
                  patchEndpoint({ name: event.target.value })
                }
                placeholder="Ollama"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="local-model">{tr("模型")}</Label>
              <Input
                id="local-model"
                value={form.localLlm.model}
                onChange={(event) =>
                  patchEndpoint({ model: event.target.value })
                }
                placeholder="qwen2.5:3b"
                spellCheck={false}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="local-base">{tr("接口地址")}</Label>
            <Input
              id="local-base"
              value={form.localLlm.baseUrl}
              onChange={(event) =>
                patchEndpoint({ baseUrl: event.target.value })
              }
              placeholder="http://127.0.0.1:11434/v1"
              spellCheck={false}
            />
            <p className="text-[11px] leading-5 text-muted-foreground">
              {tr("OpenAI 兼容的本机服务地址，直连 127.0.0.1，不经过第三方。")}
            </p>
            <div className="flex flex-wrap items-center gap-2 text-[11px] leading-5">
              {environment ? (
                environment.ollamaRunning ? (
                  <span className="inline-flex items-center gap-1.5 text-foreground">
                    <span className="size-1.5 rounded-full bg-success" />
                    {tr("Ollama 已连接")}
                    {environment.ollamaModels.length > 0
                      ? `：${environment.ollamaModels.slice(0, 3).join('、')}`
                      : ''}
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    {tr("Ollama 未运行。Windows 从 ollama.com/download 安装；macOS/Linux 可运行")}
                    <code className="mx-1 rounded bg-muted px-1 py-0.5">
                      curl -fsSL https://ollama.com/install.sh | sh
                    </code>
                  </span>
                )
              ) : (
                <span className="text-muted-foreground">{tr("正在检测本机 Ollama…")}</span>
              )}
              <Button
                variant="ghost"
                size="xs"
                className="text-muted-foreground"
                onClick={() => {
                  void probeEnvironment()
                    .then(setEnvironment)
                    .catch(() => {})
                }}
              >
                <RefreshCw />
                {tr("重新检测")}
              </Button>
            </div>
          </div>
        </section>
      )}

      {form.route === 'remoteLlm' && currentProvider && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <Label>{tr("Provider 配置档")}</Label>
            <span className="text-[11px] text-muted-foreground">
              {tr('{count} / {max} · OpenAI 兼容', {
                count: form.providers.length,
                max: MAX_PROVIDERS,
              })}
            </span>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-44 flex-1 space-y-2">
              <Label htmlFor="provider-profile">{tr("当前配置档")}</Label>
              <Select
                value={currentProvider.id}
                onValueChange={(value: string | null) => {
                  if (value) selectProvider(value)
                }}
                items={form.providers.map((provider) => ({
                  value: provider.id,
                  label: provider.name || provider.model || provider.id,
                }))}
              >
                <SelectTrigger id="provider-profile" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {form.providers.map((provider) => (
                    <SelectItem key={provider.id} value={provider.id}>
                      {provider.name || provider.model || provider.id}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <Button
              variant="outline"
              onClick={() => addProvider()}
              disabled={form.providers.length >= MAX_PROVIDERS}
            >
              <Plus />
              {tr("新增")}
            </Button>
            <Button
              variant={
                confirmDeleteProfile === currentProvider.id
                  ? 'destructive-outline'
                  : 'outline'
              }
              onClick={() => removeProvider(currentProvider.id)}
              disabled={form.providers.length <= 1}
            >
              <Trash2 />
              {confirmDeleteProfile === currentProvider.id
                ? tr("确认删除")
                : tr("删除")}
            </Button>
          </div>

          <div className="flex items-center justify-between">
            <Label>{tr("快速新建")}</Label>
            <span className="text-[11px] text-muted-foreground">
              {tr("新建一套并切换过去")}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {REMOTE_PRESETS.map((preset) => (
              <Button
                key={preset.name}
                variant="outline"
                size="sm"
                onClick={() => addProvider(preset)}
                disabled={form.providers.length >= MAX_PROVIDERS}
              >
                {preset.name}
              </Button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void importProfiles()}
            >
              <Upload />
              {tr("导入配置档…")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void exportProfiles()}
            >
              <Download />
              {tr("导出配置档…")}
            </Button>
            <span className="text-[11px] leading-5 text-muted-foreground">
              {tr("只含名称、接口地址与模型，不含 API Key 和授权；导入后需重新填 Key 并确认。")}
            </span>
          </div>
          {profileNote ? (
            <p className="text-[11px] text-muted-foreground">{profileNote}</p>
          ) : null}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="provider-name">{tr("名称")}</Label>
              <Input
                id="provider-name"
                value={currentProvider.name}
                maxLength={MAX_PROVIDER_NAME}
                onChange={(event) =>
                  patchProvider({ name: event.target.value })
                }
                placeholder="DeepSeek"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="provider-model">{tr("模型")}</Label>
              <Input
                id="provider-model"
                value={currentProvider.model}
                onChange={(event) =>
                  patchProvider({ model: event.target.value })
                }
                placeholder="deepseek-chat"
                spellCheck={false}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="provider-base">{tr("接口地址")}</Label>
            <Input
              id="provider-base"
              value={currentProvider.baseUrl}
              onChange={(event) =>
                patchProvider({ baseUrl: event.target.value })
              }
              placeholder="https://api.deepseek.com/v1"
              spellCheck={false}
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="provider-key">API Key</Label>
              {currentKeySet && (
                <button
                  type="button"
                  className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => void handleRemoveKey()}
                >
                  {tr("移除这个配置档的 Key")}
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <Input
                id="provider-key"
                type="password"
                autoComplete="off"
                className="flex-1"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={
                  currentKeySet ? tr("已存系统钥匙串 · 留空保持不变") : 'sk-…'
                }
                spellCheck={false}
              />
              <Button
                variant="outline"
                onClick={() => void handleTest()}
                loading={testing}
                disabled={needsConsent}
              >
                {tr("测试连接")}
              </Button>
            </div>
            <p className="text-[11px] leading-5 text-muted-foreground">
              {tr("每个配置档的 Key 分开存系统凭据管理器，不进入设置文件，也不经过")}
              {tr("WebView 发送。")}
            </p>
          </div>

          <div className="rounded-lg border border-warning/35 bg-warning/8 p-3">
            <p className="text-xs leading-5 text-foreground">
              {tr(
                '只有「定稿句子 + 前几句上文」会发送到 {url}。音频和整场转录不会发送；请求由这台电脑直连服务商。当前配置档同时用于翻译与问答。',
                { url: currentProvider.baseUrl || tr('该服务商') },
              )}
            </p>
            {currentProvider.consentAt ? (
              <Badge variant="success" size="sm" className="mt-2">
                <ShieldCheck />
                {tr("已授权")}
              </Badge>
            ) : (
              <label className="mt-2 flex cursor-pointer items-start gap-2 text-xs text-foreground">
                <Checkbox
                  checked={consent}
                  onCheckedChange={(checked: boolean) =>
                    setConsent(Boolean(checked))
                  }
                  aria-label="Consent to send sentence text"
                />
                <span>{tr("我理解并同意把句子文本发送给该服务商")}</span>
              </label>
            )}
          </div>
        </section>
      )}

      <section className="grid grid-cols-2 items-end gap-4">
        <div className="space-y-2">
          <Label htmlFor="context-lines">{tr("上文句数")}</Label>
          <Input
            id="context-lines"
            type="number"
            min={0}
            max={12}
            className="w-full"
            value={form.contextLines}
            onChange={(event) =>
              patch({
                contextLines: Math.max(
                  0,
                  Math.min(12, Number(event.target.value) || 0),
                ),
              })
            }
          />
          <p className="text-[11px] leading-5 text-muted-foreground">
            {tr("只用于 LLM 路线；NMT 逐句翻译。")}
          </p>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background p-3">
          <div>
            <p className="text-sm text-foreground">{tr("失败回退本地")}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {tr("先 NMT，再尝试本地 LLM")}
            </p>
          </div>
          <Switch
            checked={form.fallbackToLocal}
            onCheckedChange={(checked: boolean) =>
              patch({ fallbackToLocal: checked })
            }
            aria-label="Fall back to local routes"
          />
        </div>
      </section>

      {form.route !== 'remoteLlm' && (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => void handleTest()}
            loading={testing}
          >
            {tr("测试一句")}
          </Button>
          {form.route === 'nmt' && !view?.nmtInstalled && (
            <span className="text-[11px] text-muted-foreground">
              {tr("需要先下载本地模型")}
            </span>
          )}
        </div>
      )}

      {testResult && (
        <div className="rounded-lg border border-success/35 bg-success/6 p-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline" size="sm">
              {testResult.route}
            </Badge>
            <span className="tnum">{testResult.ms} ms</span>
            {testResult.provider && <span>· {testResult.provider}</span>}
          </div>
          <p className="mt-2 text-sm leading-6 text-foreground">
            {testResult.text}
          </p>
        </div>
      )}

      {error && (
        <p className="rounded-lg border border-destructive/35 bg-destructive/6 px-3 py-2 text-xs leading-5 text-destructive-foreground">
          {error}
        </p>
      )}
    </div>
  )
}
