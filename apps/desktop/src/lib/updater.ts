/**
 * Signed auto-updates through `tauri-plugin-updater`.
 *
 * The plugin verifies the Minisign signature of `latest.json` and of every
 * installer; the About panel only owns the check/install/relaunch flow.
 */
import { tr } from './i18n'
import { isTauri } from './engine'

export type UpdateInfo = {
  version: string
  currentVersion: string
  date?: string
  body?: string
}

type DownloadEvent = {
  event: 'Started' | 'Progress' | 'Finished'
  data?: { contentLength?: number; chunkLength?: number }
}

type PendingUpdate = UpdateInfo & {
  downloadAndInstall: (callback: (event: DownloadEvent) => void) => Promise<void>
}

let pending: PendingUpdate | null = null

export function updatesSupported(): boolean {
  return isTauri()
}

/** Check the configured endpoint; `null` means this build is current. */
export async function checkForAppUpdate(): Promise<UpdateInfo | null> {
  if (!isTauri()) {
    throw new Error(
      tr('浏览器预览不会检查更新；安装版会读取已配置的更新源。'),
    )
  }
  const { check } = await import('@tauri-apps/plugin-updater')
  const update = await check()
  if (!update) {
    pending = null
    return null
  }
  pending = update
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    date: update.date,
    body: update.body,
  }
}

/** Download and install the update found by the last check. */
export async function installAppUpdate(
  onProgress: (progress: number | null) => void,
): Promise<void> {
  if (!pending) {
    throw new Error(tr('没有待安装的更新，请先检查更新。'))
  }
  let received = 0
  let total: number | null = null
  await pending.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      total = event.data?.contentLength ?? null
      onProgress(total ? 0 : null)
    } else if (event.event === 'Progress') {
      received += event.data?.chunkLength ?? 0
      onProgress(total ? Math.min(1, received / total) : null)
    }
  })
}

export async function relaunchApp(): Promise<void> {
  const { relaunch } = await import('@tauri-apps/plugin-process')
  await relaunch()
}
