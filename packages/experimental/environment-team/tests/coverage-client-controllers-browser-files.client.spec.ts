// @vitest-environment jsdom
/** Browser file bytes round trip through canonical base64 and the download surface. */
import { afterEach, expect, it, vi } from 'vitest'
import { downloadBrowserFile, encodeBrowserFile } from '../src/client/browser-files.ts'

const original = { create: Object.getOwnPropertyDescriptor(URL, 'createObjectURL'), revoke: Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL') }
function restore(name: 'createObjectURL' | 'revokeObjectURL', descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) Reflect.deleteProperty(URL, name)
  else Object.defineProperty(URL, name, descriptor)
}
afterEach(() => {
  vi.restoreAllMocks()
  restore('createObjectURL', original.create); restore('revokeObjectURL', original.revoke)
})

it('encodes selected bytes as canonical base64 without a data URL prefix', async () => {
  const bytes = Uint8Array.of(0, 1, 2, 250, 251, 255)
  expect(await encodeBrowserFile(new File([bytes], 'bytes.bin'))).toBe(btoa(String.fromCharCode(...bytes)))
  expect(await encodeBrowserFile(new File([], 'empty.txt'))).toBe('')
})

it('saves destination bytes under the destination name and releases the object URL on disposal', async () => {
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:destination-file')
  const revokeObjectURL = vi.fn()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revokeObjectURL })
  const clicked: Pick<HTMLAnchorElement, 'href' | 'download'>[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ href: this.href, download: this.download })
  })
  const dispose = downloadBrowserFile(btoa('hello'), 'notes.txt', 'text/plain')
  expect(clicked).toEqual([{ href: 'blob:destination-file', download: 'notes.txt' }])
  const blob = createObjectURL.mock.calls[0]![0]
  expect(blob.type).toBe('text/plain')
  expect(await blob.text()).toBe('hello')
  expect(revokeObjectURL).not.toHaveBeenCalled()
  dispose()
  expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:destination-file')
})
