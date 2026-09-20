/**
 * Web e2e fixture: a named SSH environment the host composes a connection for.
 * It replaces the settings-backed registry and the lazy broker with an
 * in-memory world over the same small tree, and registers its connection with
 * the real world router, so the picker can offer the environment, list its
 * folders, and create a workspace there without an SSH server.
 */
export const name = 'fixture-ssh-world'

/** The real world router the fixture registers its connection with. */
export const inject = ['sshWorlds']

const VERSION = 'r1'
const HOME = '/home/bsdev'

/** The virtual remote world: absolute POSIX paths to entries. */
const TREE = new Map([
  ['/', { type: 'directory' }],
  ['/home', { type: 'directory' }],
  [HOME, { type: 'directory' }],
  [`${HOME}/project`, { type: 'directory' }],
  [`${HOME}/.ssh`, { type: 'directory' }],
  [`${HOME}/notes.txt`, { type: 'file', text: 'remote notes\n' }],
])

const target = path => ({ targetKey: path, displayPath: path })
const fail = (message, code) => Object.assign(new Error(message), { code })

/** Direct child names of one directory, name-sorted. */
function childrenOf(path) {
  const prefix = path === '/' ? '/' : `${path}/`
  const names = new Set()
  for (const key of TREE.keys()) {
    if (key === path || !key.startsWith(prefix)) continue
    names.add(key.slice(prefix.length).split('/')[0])
  }
  return [...names].sort((left, right) => left.localeCompare(right))
}

/** Ancestor chain from the remote root to one directory inclusive. */
function crumbsOf(path) {
  const parts = path === '/' ? [] : path.slice(1).split('/')
  const crumbs = [{ name: '/', path: '/' }]
  let current = ''
  for (const part of parts) {
    current = `${current}/${part}`
    crumbs.push({ name: part, path: current })
  }
  return crumbs
}

/** Answer one helper request over the virtual tree. */
function answer(method, params) {
  if (method === 'fs.resolve') {
    const request = params
    const base = request.cwd ?? '/'
    const path = request.path.startsWith('/') ? request.path : `${base === '/' ? '' : base}/${request.path}`
    if (!TREE.has(path)) throw fail(`not found: ${path}`, 'FS_NOT_FOUND')
    return target(path)
  }
  const entry = params.target
  const path = String(entry.targetKey)
  if (method === 'fs.stat') {
    const found = TREE.get(path)
    if (found === undefined) return null
    return found.type === 'file'
      ? { version: VERSION, type: 'file', size: found.text.length }
      : { version: VERSION, type: 'directory' }
  }
  if (method === 'fs.list') {
    return childrenOf(path).map((name) => {
      const childPath = path === '/' ? `/${name}` : `${path}/${name}`
      const found = TREE.get(childPath)
      return { name, type: found.type, target: target(childPath), version: VERSION }
    })
  }
  if (method === 'fs.mkdir') {
    if (TREE.has(path)) throw fail(`already exists: ${path}`, 'FS_ALREADY_EXISTS')
    TREE.set(path, { type: 'directory' })
    return null
  }
  throw fail(`unexpected helper method ${method}`, 'FS_IO_ERROR')
}

/** Provide the environment registry, the broker, and the routed connection. */
export function apply(ctx) {
  const connection = {
    request: async (method, params, schema) => schema.parse(answer(method, params)),
    connectStream: () => Promise.reject(new Error('the fixture world serves no stream')),
    dispose: () => Promise.resolve(),
  }
  ctx.sshWorlds.register('bsdev', connection)

  ctx.provide('sshEnvironments', {
    list: () => [{ id: 'bsdev', label: 'BSD dev', host: 'dsh-bsdev' }],
    get: (id) => id === 'bsdev' ? { host: 'dsh-bsdev', label: 'BSD dev' } : undefined,
    resolve: () => ({ host: 'dsh-bsdev' }),
    resolveRuntime: (id) => {
      if (id !== 'bsdev') throw new Error(`unknown environment ${id}`)
      return { node: '/usr/bin/node', helper: '/opt/dsh-ssh/helper.js', helperHash: 'a'.repeat(64), workspace: HOME }
    },
  })

  ctx.provide('sshBroker', {
    list: () => ['bsdev'],
    connect: async () => connection,
    listDirectory: async (id, path) => {
      const directory = path ?? HOME
      const found = TREE.get(directory)
      if (found === undefined || found.type !== 'directory') {
        throw new Error(`${directory} is not a remote directory`)
      }
      const entries = childrenOf(directory)
        .map(name => `${directory === '/' ? '' : directory}/${name}`)
        .filter(child => TREE.get(child).type === 'directory')
        .map(child => ({ name: child.slice(child.lastIndexOf('/') + 1), path: child }))
      return { path: directory, home: HOME, crumbs: crumbsOf(directory), entries }
    },
    createDirectory: async (id, path, name) => {
      const child = `${path}/${name}`
      TREE.set(child, { type: 'directory' })
      return child
    },
  })
}
