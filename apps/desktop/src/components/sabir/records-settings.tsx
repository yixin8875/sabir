import { useEffect, useImperativeHandle, useState, type Ref } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { tr } from '@/lib/i18n'
import { isTauri } from '@/lib/engine'
import {
  DEFAULT_APP_SETTINGS,
  getAppSettings,
  pickExportDir,
  saveAppSettings,
  type AppSettings,
} from '@/lib/app-settings'
import type { SettingsPanelHandle } from './recognition-settings'

type RecordsSettingsProps = {
  onDirtyChange: (dirty: boolean) => void
  ref?: Ref<SettingsPanelHandle>
}

/**
 * Where recordings are written. Rust owns the folder (and creates it), so the
 * panel only edits `exportDir` and never re-reads the transcript store.
 */
export function RecordsSettings({ onDirtyChange, ref }: RecordsSettingsProps) {
  const [saved, setSaved] = useState<AppSettings>(DEFAULT_APP_SETTINGS)
  const [dir, setDir] = useState<string | null>(null)
  const [defaultDir, setDefaultDir] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void getAppSettings().then((next) => {
      if (!alive) return
      setSaved(next)
      setDir(next.exportDir)
    })
    return () => {
      alive = false
    }
  }, [])

  // Show the resolved Documents\Sabir path instead of a placeholder.
  useEffect(() => {
    if (!isTauri()) return
    let alive = true
    void invoke<string>('default_export_dir')
      .then((path) => {
        if (alive) setDefaultDir(path)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const dirty = dir !== saved.exportDir

  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])

  async function choose() {
    const picked = await pickExportDir(tr("选择记录目录"))
    if (picked) setDir(picked)
  }

  function open() {
    if (!isTauri()) return
    void invoke("open_export_dir", { dir }).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  async function save() {
    if (!dirty) return
    setError(null)
    try {
      // Merge into the latest settings so the General page's locale/tray
      // changes are never clobbered by an older copy.
      const latest = await getAppSettings()
      const next = await saveAppSettings({ ...latest, exportDir: dir })
      setSaved(next)
      setDir(next.exportDir)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      throw cause
    }
  }

  useImperativeHandle(ref, () => ({ save }))

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="records-dir">{tr("记录目录")}</Label>
        <div className="flex flex-wrap items-center gap-2">
          <div
            id="records-dir"
            className="min-w-0 flex-1 break-all rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs leading-5 text-foreground"
          >
            {dir ?? defaultDir ?? tr("默认：文档目录下的 Sabir")}
          </div>
          <Button variant="outline" size="sm" onClick={() => void choose()}>
            {tr("选择…")}
          </Button>
          <Button variant="outline" size="sm" onClick={open}>
            {tr("打开目录")}
          </Button>
          {dir && (
            <Button variant="ghost" size="sm" onClick={() => setDir(null)}>
              {tr("恢复默认")}
            </Button>
          )}
        </div>
        <p className="text-[11px] leading-4 text-muted-foreground">
          {tr("会话记录保存在本机数据库，不会上传；导出文件默认写到这里。")}
        </p>
        <p className="text-[11px] leading-4 text-muted-foreground">
          {tr("Markdown、JSONL 与 SRT 文件保存到这里；目录不存在时会自动创建。")}
        </p>
      </div>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
