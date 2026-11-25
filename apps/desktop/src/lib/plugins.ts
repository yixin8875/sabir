import { tr } from '@/lib/i18n'
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './engine'

/**
 * Local script plugin settings.
 *
 * A plugin receives the JSONL caption event stream on stdin and may return a
 * rewritten translation on stdout. Nothing leaves the machine; in the browser
 * preview no command is ever run.
 */

export type PluginSettings = {
  enabled: boolean
  command: string
}

export type PluginSettingsView = {
  settings: PluginSettings
  /** Directory containing one `<session id>.jsonl` per session. */
  streamDir: string
  running: boolean
  lastError: string | null
}

let demoView: PluginSettingsView = {
  settings: { enabled: false, command: '' },
  streamDir: '/demo/streams',
  running: false,
  lastError: null,
}

function clone(view: PluginSettingsView): PluginSettingsView {
  return { ...view, settings: { ...view.settings } }
}

export async function getPluginSettings(): Promise<PluginSettingsView> {
  if (!isTauri()) return clone(demoView)
  return invoke<PluginSettingsView>('get_plugin_settings')
}

export async function savePluginSettings(
  settings: PluginSettings,
): Promise<PluginSettingsView> {
  const command = settings.command.trim()
  const enabled = settings.enabled && command.length > 0
  if (settings.enabled && !command) {
    throw new Error(tr('先填写插件命令，才能启用。'))
  }
  if (!isTauri()) {
    demoView = { ...demoView, settings: { enabled, command } }
    return clone(demoView)
  }
  return invoke<PluginSettingsView>('save_plugin_settings', {
    settings: { enabled, command },
  })
}

/** Run the command once with a sample sentence; used by the settings button. */
export async function testPlugin(command: string): Promise<string> {
  if (!isTauri()) {
    return tr('浏览器预览：不会运行本机脚本；安装版会启动命令并等待一次改写。')
  }
  return invoke<string>('test_plugin', { command })
}
