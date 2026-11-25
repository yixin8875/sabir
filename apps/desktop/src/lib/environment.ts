import { tr } from '@/lib/i18n'
/**
 * Read-only environment probe: memory, CPU, whether a local Ollama answers.
 * Used for onboarding hints and the local-LLM card.
 */

import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './engine'

export type Environment = {
  memoryMb: number | null
  cores: number
  ollamaRunning: boolean
  ollamaModels: string[]
  recommendedModel: string
  reason: string
}

const DEMO_ENVIRONMENT: Environment = {
  memoryMb: 16384,
  cores: 8,
  ollamaRunning: false,
  ollamaModels: [],
  recommendedModel: 'bilingual-zh-en',
  reason: tr("16.0 GB 内存、8 核：建议先下 中英双语 Zipformer（约 190MB，边说边出字）。"),
}

export async function probeEnvironment(): Promise<Environment> {
  if (!isTauri()) return DEMO_ENVIRONMENT
  return invoke<Environment>('probe_environment')
}
