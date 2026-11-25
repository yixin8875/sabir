import { useEffect, useState } from 'react'
import { Cloud, Cpu, HardDrive, Languages, ShieldCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Sheet,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import {
  clearTranslateApiKey,
  DEFAULT_TRANSLATE_SETTINGS,
  saveTranslateSettings,
  testTranslation,
  type TestTranslation,
  type TranslateRoute,
  type TranslateSettings,
  type TranslateSettingsView,
} from '@/lib/translation'
import { cn } from '@/lib/utils'

const ROUTES: {
  id: TranslateRoute
  title: string
  note: string
  icon: typeof Cpu
}[] = [
  {
    id: 'nmt',
    title: '本地 NMT',
    note: 'opus-mt en→zh，内嵌 ONNX，完全离线，几百毫秒到两秒一句。',
    icon: HardDrive,
  },
  {
    id: 'localLlm',
    title: '本地 LLM',
    note: '连接本机 Ollama / LM Studio / llama.cpp，译文更顺，需要已下载模型。',
    icon: Cpu,
  },
  {
    id: 'remoteLlm',
    title: '第三方',
    note: '任意 OpenAI 兼容服务，用你自己的 Key，仅在授权后发送句子文本。',
    icon: Cloud,
  },
]

type SettingsSheetProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  view: TranslateSettingsView | null
  onSaved: (view: TranslateSettingsView) => void
}

export function SettingsSheet({
  open,
  onOpenChange,
  view,
  onSaved,
}: SettingsSheetProps) {
  const [form, setForm] = useState<TranslateSettings>(
    view?.settings ?? DEFAULT_TRANSLATE_SETTINGS,
  )
  const [apiKey, setApiKey] = useState('')
  const [consent, setConsent] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestTranslation | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !view) return
    setForm(view.settings)
    setApiKey('')
    setConsent(false)
    setTestResult(null)
    setError(null)
  }, [open, view])

  const needsConsent =
    form.route === 'remoteLlm' && !form.remoteConsentAt && !consent

  function patch(update: Partial<TranslateSettings>) {
    setForm((current) => ({ ...current, ...update }))
  }

  async function persist(): Promise<TranslateSettingsView> {
    return saveTranslateSettings({
      settings: form,
      apiKey: apiKey.trim() ? apiKey.trim() : undefined,
      consent,
    })
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const saved = await persist()
      onSaved(saved)
      onOpenChange(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  async function handleTest() {
    setTesting(true)
    setError(null)
    setTestResult(null)
    try {
      await persist()
      setTestResult(await testTranslation(form.route))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setTesting(false)
    }
  }

  async function handleRemoveKey() {
    try {
      onSaved(await clearTranslateApiKey())
      setApiKey('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup side="right" className="max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 text-lg">
            <Languages className="size-5 text-accent-foreground" />
            翻译
          </SheetTitle>
          <SheetDescription>
            句子在静音处定稿后才翻译，前面的几句会作为上下文。
            音频与识别结果始终留在本机。
          </SheetDescription>
        </SheetHeader>

        <SheetPanel className="space-y-7">
          <div className="flex items-start justify-between gap-4 rounded-xl border border-border bg-background p-3.5">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">实时翻译</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                关闭后只保留原文；已有译文仍显示。
              </p>
            </div>
            <Switch
              checked={form.enabled}
              onCheckedChange={(checked: boolean) => patch({ enabled: checked })}
              aria-label="Enable translation"
            />
          </div>

          <section className="space-y-2.5">
            <Label>用哪条路</Label>
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
                              已安装
                            </Badge>
                          ) : (
                            <Badge variant="warning" size="sm">
                              缺模型
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

          {form.route === 'nmt' && !view?.nmtInstalled && (
            <div className="rounded-lg border border-warning/35 bg-warning/8 p-3">
              <p className="text-xs leading-5 text-foreground">
                本地 NMT 模型还没装好。把 opus-mt en→zh 的 ONNX 文件和
                tokenizer.json 放到：
              </p>
              <p className="mt-1.5 break-all font-mono text-[11px] text-muted-foreground">
                {view?.nmtDir}
              </p>
              <p className="mt-1.5 text-xs text-muted-foreground">
                下载步骤见 README；也可以先用本地 LLM 或第三方。
              </p>
            </div>
          )}

          {form.route === 'localLlm' && (
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <Label htmlFor="local-base">本地服务地址</Label>
                <span className="text-[11px] text-muted-foreground">
                  OpenAI 兼容 · 127.0.0.1
                </span>
              </div>
              <Input
                id="local-base"
                value={form.localLlm.baseUrl}
                onChange={(event) =>
                  patch({
                    localLlm: { ...form.localLlm, baseUrl: event.target.value },
                  })
                }
                placeholder="http://127.0.0.1:11434/v1"
                spellCheck={false}
              />
              <Label htmlFor="local-model">模型</Label>
              <Input
                id="local-model"
                value={form.localLlm.model}
                onChange={(event) =>
                  patch({
                    localLlm: { ...form.localLlm, model: event.target.value },
                  })
                }
                placeholder="qwen2.5:3b"
                spellCheck={false}
              />
            </section>
          )}

          {form.route === 'remoteLlm' && (
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <Label htmlFor="remote-base">服务地址</Label>
                <span className="text-[11px] text-muted-foreground">
                  OpenAI 兼容 HTTPS
                </span>
              </div>
              <Input
                id="remote-base"
                value={form.remoteLlm.baseUrl}
                onChange={(event) =>
                  patch({
                    remoteLlm: { ...form.remoteLlm, baseUrl: event.target.value },
                  })
                }
                placeholder="https://api.deepseek.com/v1"
                spellCheck={false}
              />
              <Label htmlFor="remote-model">模型</Label>
              <Input
                id="remote-model"
                value={form.remoteLlm.model}
                onChange={(event) =>
                  patch({
                    remoteLlm: { ...form.remoteLlm, model: event.target.value },
                  })
                }
                placeholder="deepseek-chat"
                spellCheck={false}
              />
              <div className="flex items-center justify-between">
                <Label htmlFor="remote-key">API Key</Label>
                {view?.apiKeySet && (
                  <button
                    type="button"
                    className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                    onClick={() => void handleRemoveKey()}
                  >
                    移除已保存的 Key
                  </button>
                )}
              </div>
              <Input
                id="remote-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={
                  view?.apiKeySet ? '已存系统钥匙串 · 留空保持不变' : 'sk-…'
                }
                spellCheck={false}
              />
              <p className="text-[11px] leading-5 text-muted-foreground">
                Key 只写入 Windows 凭据管理器 / macOS 钥匙串 / libsecret，
                不进入设置文件，也不经过 WebView 发送。
              </p>

              <div className="rounded-lg border border-warning/35 bg-warning/8 p-3">
                <p className="text-xs leading-5 text-foreground">
                  只有「定稿句子 + 前几句上文」会发送到{' '}
                  {form.remoteLlm.baseUrl || '该服务商'}。音频和整场转录不会发送；
                  请求由这台电脑直连服务商。
                </p>
                {form.remoteConsentAt ? (
                  <Badge variant="success" size="sm" className="mt-2">
                    <ShieldCheck />
                    已授权
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
                    <span>我理解并同意把句子文本发送给该服务商</span>
                  </label>
                )}
              </div>
            </section>
          )}

          <section className="grid grid-cols-2 items-end gap-4">
            <div className="space-y-2">
              <Label htmlFor="context-lines">上文句数</Label>
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
                只用于 LLM 路线；NMT 逐句翻译。
              </p>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background p-3">
              <div>
                <p className="text-sm text-foreground">失败回退本地</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  先 NMT，再尝试本地 LLM
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
        </SheetPanel>

        <SheetFooter>
          <Button
            variant="outline"
            onClick={() => void handleTest()}
            loading={testing}
            disabled={needsConsent}
          >
            测试一句
          </Button>
          <Button
            onClick={() => void handleSave()}
            loading={saving}
            disabled={needsConsent}
          >
            保存
          </Button>
        </SheetFooter>
      </SheetPopup>
    </Sheet>
  )
}
