import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './engine'
import { tr } from './i18n'
import { downloadJsonFile } from './portable-file'

function stamp(): string {
  return new Date()
    .toISOString()
    .slice(0, 19)
    .replace(/[:T]/g, '-')
}

/**
 * Pick a destination and let Rust build the zip. Resolves `null` when the user
 * cancels; the browser preview downloads a small JSON sample instead of
 * touching local data.
 */
export async function exportDiagnosticsBundle(): Promise<string | null> {
  const defaultName = `sabir-diagnostics-${stamp()}.zip`
  if (!isTauri()) {
    downloadJsonFile(defaultName.replace(/\.zip$/, '.json'), {
      note: 'browser preview: no local data is read',
      generatedAt: new Date().toISOString(),
      app: { name: 'Sabir', version: '0.1.0' },
      store: { sessions: 2, segments: 10, integrity: 'ok' },
    })
    return tr('浏览器预览：已生成诊断摘要文件。')
  }
  const { save } = await import('@tauri-apps/plugin-dialog')
  const path = await save({
    defaultPath: defaultName,
    filters: [{ name: 'Zip', extensions: ['zip'] }],
    title: tr('保存诊断包'),
  })
  if (!path) return null
  return invoke<string>('export_diagnostics', { path })
}
