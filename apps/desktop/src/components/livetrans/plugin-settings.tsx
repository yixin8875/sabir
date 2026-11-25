import { tr } from '@/lib/i18n'
import {
  useEffect,
  useImperativeHandle,
  useState,
  type Ref,
} from 'react'
import { Play, Plug, ScrollText } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  savePluginSettings,
  testPlugin,
  type PluginSettings,
  type PluginSettingsView,
} from '@/lib/plugins'
import type { SettingsPanelHandle } from './recognition-settings'

type PluginSettingsProps = {
  view: PluginSettingsView | null
  onReload: () => Promise<void>
  onSaved: (view: PluginSettingsView) => void
  onDirtyChange: (dirty: boolean) => void
  ref?: Ref<SettingsPanelHandle>
}

export function PluginSettings({
  view,
  onSaved,
  onDirtyChange,
  ref,
}: PluginSettingsProps) {
  const [form, setForm] = useState<PluginSettings>(
    view?.settings ?? { enabled: false, command: '' },
  )
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)

  const settingsKey = view ? JSON.stringify(view.settings) : ''
  useEffect(() => {
    if (!view) return
    setForm(view.settings)
    setError(null)
    setTestResult(null)
  }, [settingsKey, view])

  useEffect(() => {
    onDirtyChange(JSON.stringify(form) !== settingsKey)
  }, [form, settingsKey, onDirtyChange])

  async function save() {
    setError(null)
    try {
      const next = await savePluginSettings(form)
      onSaved(next)
      setForm(next.settings)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      throw cause
    }
  }

  useImperativeHandle(ref, () => ({ save }))

  async function runTest() {
    setTesting(true)
    setTestResult(null)
    setError(null)
    try {
      setTestResult(await testPlugin(form.command))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm leading-6 text-muted-foreground">
        {tr(
          "把每句字幕和译文作为 JSONL 事件交给本机脚本；脚本可以返回改写后的译文。事件同时写入事件流文件，供 Obsidian、Notion 等工具跟随。",
        )}
      </p>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-foreground">
          {tr("脚本插件")}
        </h2>
        <div className="space-y-4 rounded-xl border border-border bg-muted/25 p-4">
          <div className="flex items-start gap-3">
            <Switch
              id="plugin-enabled"
              checked={form.enabled}
              disabled={!form.command.trim()}
              onCheckedChange={(value) =>
                setForm((current) => ({ ...current, enabled: value }))
              }
              className="mt-0.5"
            />
            <div className="min-w-0 space-y-1">
              <Label htmlFor="plugin-enabled">{tr("启用脚本插件")}</Label>
              <p className="text-xs leading-5 text-muted-foreground">
                {tr(
                  "监听开始时启动，停止时结束；命令经系统 shell 在本机运行，不联网。",
                )}
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="plugin-command">{tr("命令")}</Label>
            <Input
              id="plugin-command"
              value={form.command}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  command: event.target.value,
                }))
              }
              placeholder="python C:\\plugins\\livetrans.py"
              spellCheck={false}
              className="font-mono text-xs"
            />
            <p className="text-[11px] leading-4 text-muted-foreground">
              {tr(
                '标准输入是 JSONL 事件；在标准输出返回 {"type":"rewrite","id":1,"text":"…"} 可改写译文。stdout 需为 UTF-8。',
              )}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void runTest()}
              loading={testing}
              disabled={!form.command.trim()}
            >
              <Play />
              {tr("测试命令")}
            </Button>
            {view?.running && (
              <Badge variant="secondary" size="sm">
                {tr("运行中")}
              </Badge>
            )}
            {testResult && (
              <p className="text-xs leading-5 text-muted-foreground">
                {testResult}
              </p>
            )}
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-foreground">
          {tr("事件流")}
        </h2>
        <div className="rounded-xl border border-border bg-muted/25 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <ScrollText className="size-4 text-muted-foreground" />
            {tr("每场会话一个 JSONL 文件")}
          </div>
          <p className="mt-1.5 break-all font-mono text-[11px] leading-5 text-muted-foreground">
            {view?.streamDir ?? tr("读取中…")}
            {tr('/<会话 id>.jsonl')}
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {tr(
              "包含 session、status、partial、final、translationDelta、translationDone、translationError、error 与 sessionEnd；电平事件不写入。命令行可用 livetrans stream --follow 跟随最新一场。",
            )}
          </p>
          <p className="mt-2 flex items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
            <Plug className="size-3" />
            {tr("脚本未启用时事件流仍会写入。")}
          </p>
          {view?.lastError && (
            <p className="mt-2 text-xs leading-5 text-destructive-foreground">
              {view.lastError}
            </p>
          )}
        </div>
      </section>

      {error && (
        <p className="text-xs leading-5 text-destructive-foreground">{error}</p>
      )}
    </div>
  )
}
