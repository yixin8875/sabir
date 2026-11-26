import { tr } from '@/lib/i18n'
/**
 * Bridge to the Rust glossary (scene presets + terminology).
 *
 * Only text crosses this boundary. The file lives in the app config directory
 * and the active preset steers LLM translation, ASR hotwords and transcript
 * Q&A.
 */

import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './engine'
import { downloadJsonFile, pickJsonFile } from './portable-file'

export type GlossaryTerm = {
  source: string
  target: string
}

export type GlossaryPreset = {
  id: string
  name: string
  scene: string
  terms: GlossaryTerm[]
}

export type Glossary = {
  activeId: string
  presets: GlossaryPreset[]
}

export const GENERAL_ID = 'general'
export const GENERAL_NAME = tr('通用（不限场景）')
export const MAX_PRESETS = 20
export const MAX_NAME = 40
export const MAX_SCENE = 600
export const MAX_TERMS = 200

export function generalPreset(): GlossaryPreset {
  return { id: GENERAL_ID, name: GENERAL_NAME, scene: '', terms: [] }
}

export function defaultGlossary(): Glossary {
  return { activeId: GENERAL_ID, presets: [generalPreset()] }
}

/** The preset steering translation and Q&A, falling back to the first one. */
export function activePreset(glossary: Glossary): GlossaryPreset {
  return (
    glossary.presets.find((preset) => preset.id === glossary.activeId) ??
    glossary.presets[0] ??
    generalPreset()
  )
}

let demoGlossary: Glossary = defaultGlossary()

export async function loadGlossary(): Promise<Glossary> {
  if (!isTauri()) return structuredClone(demoGlossary)
  return invoke<Glossary>('get_glossary')
}

export async function saveGlossary(glossary: Glossary): Promise<Glossary> {
  if (!isTauri()) {
    demoGlossary = structuredClone(glossary)
    return structuredClone(demoGlossary)
  }
  return invoke<Glossary>('save_glossary', { glossary })
}

const PORTABLE_FILE = 'sabir-glossary.json'

/**
 * Write every preset that has content to a shared JSON file. Returns the path
 * in the app, `null` in the browser preview (which downloads the file).
 */
export async function exportGlossaryFile(
  glossary: Glossary,
): Promise<string | null> {
  const presets = glossary.presets
    .filter(
      (preset) =>
        preset.id !== GENERAL_ID &&
        (preset.scene.trim().length > 0 || preset.terms.length > 0),
    )
    .map((preset) => ({
      name: preset.name.trim(),
      scene: preset.scene.trim(),
      terms: preset.terms,
    }))
  if (presets.length === 0) {
    throw new Error(tr('没有可导出的预设：先填写场景内容或术语。'))
  }
  if (!isTauri()) {
    downloadJsonFile(PORTABLE_FILE, {
      app: 'sabir',
      kind: 'glossary',
      version: 1,
      presets,
    })
    return null
  }
  const { save } = await import('@tauri-apps/plugin-dialog')
  const path = await save({
    defaultPath: PORTABLE_FILE,
    filters: [{ name: 'JSON', extensions: ['json'] }],
    title: tr('导出术语表'),
  })
  if (!path) return null
  return invoke<string>('export_glossary', { path, glossary })
}

/**
 * Read a shared glossary file. Returns fresh-id presets to merge into the
 * glossary being edited, or `null` when the user cancels.
 */
export async function importGlossaryFile(): Promise<GlossaryPreset[] | null> {
  if (!isTauri()) return importDemoGlossary()
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({
    directory: false,
    multiple: false,
    filters: [{ name: 'JSON', extensions: ['json'] }],
    title: tr('选择术语表文件'),
  })
  if (typeof picked !== 'string') return null
  return invoke<GlossaryPreset[]>('import_glossary', { path: picked })
}

async function importDemoGlossary(): Promise<GlossaryPreset[] | null> {
  const raw = await pickJsonFile()
  if (raw === null) return null
  const document = raw as { presets?: unknown }
  const items = Array.isArray(document?.presets) ? document.presets : []
  const presets: GlossaryPreset[] = []
  for (const item of items) {
    if (presets.length >= MAX_PRESETS) break
    if (typeof item !== 'object' || item === null) continue
    const record = item as {
      name?: unknown
      scene?: unknown
      terms?: unknown
    }
    const name =
      typeof record.name === 'string'
        ? record.name.trim().slice(0, MAX_NAME)
        : ''
    const scene =
      typeof record.scene === 'string'
        ? record.scene.trim().slice(0, MAX_SCENE)
        : ''
    const seen = new Set<string>()
    const terms: GlossaryTerm[] = []
    if (Array.isArray(record.terms)) {
      for (const entry of record.terms) {
        if (typeof entry !== 'object' || entry === null) continue
        const term = entry as { source?: unknown; target?: unknown }
        const source =
          typeof term.source === 'string' ? term.source.trim() : ''
        const target =
          typeof term.target === 'string' ? term.target.trim() : ''
        if (!source || !target || seen.has(source.toLowerCase())) continue
        seen.add(source.toLowerCase())
        terms.push({ source, target })
        if (terms.length >= MAX_TERMS) break
      }
    }
    if (!scene && terms.length === 0) continue
    presets.push({ id: `import-${presets.length + 1}`, name, scene, terms })
  }
  if (presets.length === 0) {
    throw new Error(tr('文件里没有带内容（场景或术语）的预设。'))
  }
  return presets
}
