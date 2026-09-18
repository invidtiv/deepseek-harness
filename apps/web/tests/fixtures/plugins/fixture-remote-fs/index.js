/**
 * Web e2e fixture: a filesystem whose execution world is not the harness host.
 * It serves a small virtual tree and reports `addressesHostFilesystem: false`,
 * the fact the adaptive directory chooser reads. Only the seam members the Web
 * workspace picker and the workspace registry exercise are implemented.
 */
export const name = 'fixture-remote-fs'

const VERSION = 'v1'

/** The virtual world: absolute POSIX paths to directory and file entries. */
const TREE = new Map([
  ['/', { type: 'directory' }],
  ['/remote-project', { type: 'directory' }],
  ['/remote-project/README.md', { type: 'file', text: '# Remote project\n' }],
  ['/notes.txt', { type: 'file', text: 'notes\n' }],
])

const target = path => ({ targetKey: path, displayPath: path })

/** Direct child names of one virtual directory, name-sorted. */
const childrenOf = (path) => {
  const prefix = path === '/' ? '/' : `${path}/`
  const names = new Set()
  for (const key of TREE.keys()) {
    if (key === path || !key.startsWith(prefix)) continue
    names.add(key.slice(prefix.length).split('/')[0])
  }
  return [...names].sort((left, right) => left.localeCompare(right))
}

const fail = (message, code) => Object.assign(new Error(message), { code })

/** Provide the composed filesystem for the whole Web boot. */
export function apply(ctx) {
  const fs = {
    sandboxMode: undefined,
    addressesHostFilesystem: false,
    async resolve(path, opts) {
      const base = opts?.cwd ?? '/'
      const absolute = path.startsWith('/') ? path : `${base === '/' ? '' : base}/${path}`
      if (!TREE.has(absolute)) throw fail(`not found: ${absolute}`, 'FS_NOT_FOUND')
      return target(absolute)
    },
    processPath(entry) { return String(entry.targetKey) },
    processPathFromHostPath() { return undefined },
    fileUrl(entry) { return new URL(`file://${String(entry.targetKey)}`).href },
    contains(parent, child) {
      const outer = String(parent.targetKey)
      const inner = String(child.targetKey)
      return inner === outer || inner.startsWith(outer === '/' ? '/' : `${outer}/`)
    },
    async stat(entry) {
      const found = TREE.get(String(entry.targetKey))
      if (found === undefined) return undefined
      return found.type === 'file'
        ? { version: VERSION, type: 'file', size: found.text.length }
        : { version: VERSION, type: 'directory' }
    },
    async lstat(path) {
      const found = TREE.get(path)
      return found === undefined ? undefined : { version: VERSION, type: found.type }
    },
    async readText(entry) {
      const found = TREE.get(String(entry.targetKey))
      if (found === undefined) throw fail('not found', 'FS_NOT_FOUND')
      if (found.type !== 'file') throw fail('not a file', 'FS_NOT_REGULAR_FILE')
      return found.text
    },
    async streamText(entry) {
      const text = await fs.readText(entry)
      return (async function* () { yield text })()
    },
    async readBytes(entry) { return Buffer.from(await fs.readText(entry)) },
    async readByteRange(entry, range) {
      return Buffer.from(await fs.readText(entry)).subarray(range.offset, range.offset + range.length)
    },
    async listDir(entry) {
      const path = String(entry.targetKey)
      if (TREE.get(path)?.type !== 'directory') throw fail('not a directory', 'FS_NOT_DIRECTORY')
      return childrenOf(path).map((childName) => {
        const childPath = path === '/' ? `/${childName}` : `${path}/${childName}`
        const found = TREE.get(childPath)
        return {
          name: childName,
          type: found.type,
          target: target(childPath),
          version: VERSION,
          ...found.type === 'file' ? { size: found.text.length } : {},
        }
      })
    },
    async mkdir(entry) {
      const path = String(entry.targetKey)
      if (TREE.has(path)) throw fail(`already exists: ${path}`, 'FS_ALREADY_EXISTS')
      TREE.set(path, { type: 'directory' })
    },
    async writeText(entry, content) {
      const path = String(entry.targetKey)
      const before = TREE.get(path)?.text ?? null
      TREE.set(path, { type: 'file', text: content })
      return { operation: before === null ? 'create' : 'update', version: VERSION, before, after: content }
    },
    async editText(entry, edit) {
      const path = String(entry.targetKey)
      const before = TREE.get(path)?.text ?? ''
      const after = before.split(edit.oldString).join(edit.newString)
      TREE.set(path, { type: 'file', text: after })
      return { version: VERSION, before, after }
    },
  }
  ctx.provide('fs', fs)
}
