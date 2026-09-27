/** Browser file bytes for explicitly scoped destination upload and download operations. */
/** Read one selected file as canonical base64.
 * @param file - browser-selected file, checked against the destination limit by its caller.
 * @returns encoded file bytes without a data URL prefix.
 */
export async function encodeBrowserFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
/** Save destination-approved attachment bytes through the browser download surface.
 * @param data - canonical base64 supplied by the destination.
 * @param name - destination display name.
 * @param mediaType - destination MIME type.
 * @returns disposer for the owned download URL after navigation or plugin teardown.
 */
export function downloadBrowserFile(data: string, name: string, mediaType: string): () => void {
  const binary = atob(data)
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: mediaType }))
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = name
  anchor.click()
  return () => { URL.revokeObjectURL(url) }
}
