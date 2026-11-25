import { tr } from './i18n'
/**
 * Browser-preview stand-ins for the native file dialogs.
 *
 * In the Tauri app the settings pages use `@tauri-apps/plugin-dialog` and Rust
 * reads/writes the chosen path. The preview has no native dialogs, so exports
 * become a normal download and imports read a picked file in the page. Both
 * paths return the same parsed shape for the page's merge logic.
 */

export function downloadJsonFile(name: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Parse a JSON file the user picks; resolves `null` when they cancel. */
export function pickJsonFile(): Promise<unknown | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.style.display = 'none'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      input.remove()
      if (!file) {
        resolve(null)
        return
      }
      void file
        .text()
        .then((text) => resolve(JSON.parse(text) as unknown))
        .catch(() => reject(new Error(tr('文件不是有效的 JSON。'))))
    })
    input.addEventListener('cancel', () => {
      input.remove()
      resolve(null)
    })
    document.body.appendChild(input)
    input.click()
  })
}
