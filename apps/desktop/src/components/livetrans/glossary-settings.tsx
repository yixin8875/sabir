import { tr } from '@/lib/i18n'
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from 'react'
import { Download, Plus, Trash2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { isTauri } from '@/lib/engine'
import {
  activePreset,
  defaultGlossary,
  exportGlossaryFile,
  GENERAL_ID,
  importGlossaryFile,
  loadGlossary,
  MAX_NAME,
  MAX_PRESETS,
  MAX_SCENE,
  MAX_TERMS,
  saveGlossary,
  type Glossary,
  type GlossaryPreset,
} from '@/lib/glossary'
import type { SettingsPanelHandle } from './recognition-settings'

type GlossarySettingsProps = {
  onDirtyChange: (dirty: boolean) => void
  onSaved?: (glossary: Glossary) => void
  ref?: Ref<SettingsPanelHandle>
}

function presetLabel(preset: GlossaryPreset) {
  if (preset.id === GENERAL_ID) return tr('通用（不限场景）')
  return preset.name.trim() || tr("未命名场景")
}

export function GlossarySettings({
  onDirtyChange,
  onSaved,
  ref,
}: GlossarySettingsProps) {
  const [form, setForm] = useState<Glossary>(defaultGlossary)
  const [saved, setSaved] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [deleteArmed, setDeleteArmed] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    loadGlossary()
      .then((glossary) => {
        if (cancelled) return
        setForm(glossary)
        setSaved(JSON.stringify(glossary))
        setLoading(false)
      })
      .catch((cause) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : String(cause))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (loading) return
    onDirtyChange(JSON.stringify(form) !== saved)
  }, [form, saved, loading, onDirtyChange])

  const preset = activePreset(form)
  const isGeneral = preset.id === GENERAL_ID

  async function save() {
    setError(null)
    try {
      const result = await saveGlossary(form)
      setForm(result)
      setSaved(JSON.stringify(result))
      onSaved?.(result)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      throw new Error(message)
    }
  }

  useImperativeHandle(ref, () => ({ save }))

  function selectPreset(id: string | null) {
    if (!id) return
    setDeleteArmed(false)
    setForm((current) => ({ ...current, activeId: id }))
  }

  function addPreset() {
    if (form.presets.length >= MAX_PRESETS) return
    const id = `preset-${Date.now().toString(36)}-${form.presets.length}`
    const created: GlossaryPreset = {
      id,
      name: tr('场景 {n}', { n: form.presets.length }),
      scene: '',
      terms: [],
    }
    setDeleteArmed(false)
    setForm((current) => ({
      ...current,
      activeId: id,
      presets: [...current.presets, created],
    }))
    window.setTimeout(() => nameRef.current?.focus(), 40)
  }

  function patchPreset(patch: Partial<GlossaryPreset>) {
    setForm((current) => ({
      ...current,
      presets: current.presets.map((item) =>
        item.id === current.activeId ? { ...item, ...patch } : item,
      ),
    }))
  }

  function setTerm(
    index: number,
    patch: { source?: string; target?: string },
  ) {
    setForm((current) => ({
      ...current,
      presets: current.presets.map((item) =>
        item.id === current.activeId
          ? {
              ...item,
              terms: item.terms.map((term, position) =>
                position === index ? { ...term, ...patch } : term,
              ),
            }
          : item,
      ),
    }))
  }

  function addTerm() {
    setForm((current) => ({
      ...current,
      presets: current.presets.map((item) =>
        item.id === current.activeId && item.terms.length < MAX_TERMS
          ? { ...item, terms: [...item.terms, { source: '', target: '' }] }
          : item,
      ),
    }))
  }

  function removeTerm(index: number) {
    setForm((current) => ({
      ...current,
      presets: current.presets.map((item) =>
        item.id === current.activeId
          ? {
              ...item,
              terms: item.terms.filter((_, position) => position !== index),
            }
          : item,
      ),
    }))
  }

  function deletePreset() {
    if (isGeneral) return
    if (!deleteArmed) {
      setDeleteArmed(true)
      return
    }
    setForm((current) => ({
      activeId: GENERAL_ID,
      presets: current.presets.filter((item) => item.id !== current.activeId),
    }))
    setDeleteArmed(false)
  }

  async function exportPresets() {
    setError(null)
    setNote(null)
    try {
      const path = await exportGlossaryFile(form)
      if (path) setNote(tr('已导出：{path}', { path }))
      else if (!isTauri()) setNote(tr('浏览器预览：已生成下载文件。'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function importPresets() {
    setError(null)
    setNote(null)
    const room = MAX_PRESETS - form.presets.length
    if (room <= 0) {
      setError(
        tr('预设已达上限（{n}），先删除一些再导入。', { n: MAX_PRESETS }),
      )
      return
    }
    try {
      const incoming = await importGlossaryFile()
      if (!incoming || incoming.length === 0) return
      const used = new Set(form.presets.map((item) => item.id))
      const stamp = Date.now().toString(36)
      const added: GlossaryPreset[] = []
      for (const preset of incoming) {
        if (added.length >= room) break
        const base = preset.id || `import-${stamp}`
        let id = base
        let suffix = 1
        while (used.has(id)) {
          suffix += 1
          id = `${base}-${suffix}`
        }
        used.add(id)
        added.push({ ...preset, id })
      }
      if (added.length === 0) return
      setForm({
        ...form,
        activeId: added[0].id,
        presets: [...form.presets, ...added],
      })
      setDeleteArmed(false)
      setNote(
        incoming.length > added.length
          ? tr('已加入 {n} 个预设（其余超出 {max} 个上限）。保存后生效。', {
              n: added.length,
              max: MAX_PRESETS,
            })
          : tr('已加入 {n} 个预设。保存后生效。', { n: added.length }),
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">{tr("正在读取场景预设…")}</p>
  }

  return (
    <div className="space-y-6">
      <section className="space-y-2.5">
        <Label>{tr("场景背景")}</Label>
        <p className="text-[11px] text-muted-foreground">
          {tr("简短交代音频的主题、讲师或容易听错的专有名词。识别、翻译与问答都会参考当前预设。")}
        </p>
        <div className="flex items-center gap-2">
          <Select
            value={form.activeId}
            onValueChange={selectPreset}
            items={form.presets.map((item) => ({
              value: item.id,
              label: presetLabel(item),
            }))}
          >
            <SelectTrigger className="flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {form.presets.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {presetLabel(item)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={addPreset}
            disabled={form.presets.length >= MAX_PRESETS}
            className="shrink-0"
          >
            <Plus />
            {tr("新增预设")}
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void importPresets()}
          >
            <Upload />
            {tr("导入预设…")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void exportPresets()}
          >
            <Download />
            {tr("导出预设…")}
          </Button>
          <span className="text-[11px] text-muted-foreground">
            {tr("JSON 文件只含预设名称、场景与术语；导入会追加到当前列表。")}
          </span>
        </div>
        {note ? (
          <p className="text-[11px] text-muted-foreground">{note}</p>
        ) : null}

        {isGeneral ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-3 text-[13px] leading-5 text-muted-foreground">
            {tr("不附加特定领域背景，适合日常视频或综合直播。如需针对特定课程、会议或直播优化，")}
            {tr("点上方「新增预设」，再填写场景与术语。")}
          </p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="preset-name">{tr("预设名称")}</Label>
              <Input
                id="preset-name"
                ref={nameRef}
                value={preset.name}
                maxLength={MAX_NAME}
                onChange={(event) => patchPreset({ name: event.target.value })}
                placeholder={tr("例如：产品评审、高数课、PA 直播")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="glossary-scene">{tr("场景内容")}</Label>
              <Textarea
                id="glossary-scene"
                value={preset.scene}
                onChange={(event) => patchPreset({ scene: event.target.value })}
                maxLength={MAX_SCENE}
                rows={3}
                placeholder={tr("例如：一场关于云原生与供应链的产品评审，参与者会说 Kubernetes、灰度发布、季度目标。")}
              />
              <p className="text-right text-[11px] text-muted-foreground">
                {preset.scene.length}/{MAX_SCENE}
              </p>
            </div>
          </div>
        )}
      </section>

      {!isGeneral ? (
        <section className="space-y-2.5">
          <div className="flex items-end justify-between gap-3">
            <div className="min-w-0">
              <Label>{tr("术语")}</Label>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {tr("只属于当前预设。翻译会统一采用这里的译法，问答把它们当作背景知识。")}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={addTerm}
              disabled={preset.terms.length >= MAX_TERMS}
            >
              <Plus />
              {tr("添加术语")}
            </Button>
          </div>

          {preset.terms.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
              {tr("还没有术语。人名、产品名、缩写最适合放进来。")}
            </div>
          ) : (
            <div className="space-y-2">
              {preset.terms.map((term, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    value={term.source}
                    onChange={(event) =>
                      setTerm(index, { source: event.target.value })
                    }
                    placeholder={tr("原文，如 Kubernetes")}
                    aria-label={tr('术语 {n} 原文', { n: index + 1 })}
                  />
                  <span className="shrink-0 text-muted-foreground">→</span>
                  <Input
                    value={term.target}
                    onChange={(event) =>
                      setTerm(index, { target: event.target.value })
                    }
                    placeholder={tr("期望译法，如 Kubernetes 集群")}
                    aria-label={tr('术语 {n} 译文', { n: index + 1 })}
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={tr('删除术语 {n}', { n: index + 1 })}
                    onClick={() => removeTerm(index)}
                    className="shrink-0 text-muted-foreground"
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            {tr('最多 {n} 条，保存时自动去掉空行与重复原文。', { n: MAX_TERMS })}
          </p>

          <div className="flex justify-end pt-1">
            <Button
              variant={deleteArmed ? 'destructive' : 'ghost'}
              size="sm"
              onClick={deletePreset}
              className="text-muted-foreground"
            >
              <Trash2 />
              {deleteArmed ? tr("确认删除预设") : tr("删除预设")}
            </Button>
          </div>
        </section>
      ) : null}

      <section className="space-y-1 text-xs text-muted-foreground">
        <p>
          {tr("作用范围：本地 LLM 与第三方翻译会按当前预设统一译法；本场问答会带上场景与术语帮助理解。")}
          {tr("本地 NMT 模型不读取术语表。")}
        </p>
        <p>
          {tr("流式识别模型（Zipformer）会把原文术语作为热词；Whisper 整段识别不支持热词，")}
          {tr("术语仍然作用于翻译和问答。首页的场景选择随保存切换。")}
        </p>
      </section>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
