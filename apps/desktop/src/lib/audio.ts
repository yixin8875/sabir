import { tr } from '@/lib/i18n'
/**
 * Bridge to the audio source settings.
 *
 * Rust owns the WASAPI endpoints; the WebView picks the source (system audio,
 * microphone, both mixed, or one application), the devices, and the process to
 * capture. Audio itself never reaches the WebView.
 */

import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './engine'

export type AudioSource = 'system' | 'microphone' | 'both' | 'process'

export type AudioSettings = {
  source: AudioSource
  device: string | null
  micDevice: string | null
  processId: number | null
}

export type AudioDevice = {
  id: string
  name: string
}

export type AudioDevices = {
  outputs: AudioDevice[]
  inputs: AudioDevice[]
}

export type AudioProcess = {
  pid: number
  name: string
  sessions: number
}

export const AUDIO_SOURCE_LABELS: Record<AudioSource, string> = {
  system: tr("系统声音"),
  microphone: tr("麦克风"),
  both: tr("系统声音 + 麦克风"),
  process: tr("单个应用"),
}

export function audioSourceLabel(source: AudioSource): string {
  return AUDIO_SOURCE_LABELS[source]
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  source: 'system',
  device: null,
  micDevice: null,
  processId: null,
}

const DEMO_DEVICES: AudioDevices = {
  outputs: [{ id: 'demo-speakers', name: tr("扬声器（演示）") }],
  inputs: [{ id: 'demo-mic', name: tr("麦克风（演示）") }],
}

const DEMO_PROCESSES: AudioProcess[] = [
  { pid: 1201, name: 'chrome.exe', sessions: 2 },
  { pid: 2202, name: 'Teams.exe', sessions: 1 },
  { pid: 3303, name: 'Spotify.exe', sessions: 1 },
]

export async function getAudioSettings(): Promise<AudioSettings> {
  if (!isTauri()) return DEFAULT_AUDIO_SETTINGS
  return invoke<AudioSettings>('get_audio_settings')
}

export async function saveAudioSettings(
  settings: AudioSettings,
): Promise<AudioSettings> {
  if (!isTauri()) return settings
  return invoke<AudioSettings>('save_audio_settings', { settings })
}

export async function listAudioDevices(): Promise<AudioDevices> {
  if (!isTauri()) return DEMO_DEVICES
  return invoke<AudioDevices>('list_audio_devices')
}

export async function listAudioProcesses(): Promise<AudioProcess[]> {
  if (!isTauri()) return DEMO_PROCESSES
  return invoke<AudioProcess[]>('list_audio_processes')
}
