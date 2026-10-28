/** Interoperability probe importing a caller-selected T3 checkout's actual generic runtime. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [root, optionsFile] = process.argv.slice(2)
const requireT3 = createRequire(join(root, 'apps/server/package.json'))
const load = name => import(pathToFileURL(requireT3.resolve(name)).href)
const Effect = await load('effect/Effect')
const Stream = await load('effect/Stream')
const Deferred = await load('effect/Deferred')
const Fiber = await load('effect/Fiber')
const NodeServices = await load('@effect/platform-node/NodeServices')
// The runtime moved from apps/server into the provider-acp workspace package (T3 Code ed0f7b908b2e).
// Its package exports are ESM-only, so createRequire.resolve cannot select them.
const Runtime = await import(pathToFileURL(join(root, 'packages/provider-acp/src/server/AcpSessionRuntime.ts')).href)
const options = JSON.parse(await readFile(optionsFile, 'utf8'))

await Effect.runPromise(Effect.gen(function* () {
  const runtime = yield* Runtime.make(options)
  const events = []
  const waiters = new Set()
  const waitFor = predicate => Effect.promise(() => new Promise(resolve => {
    const check = () => { if (predicate()) { waiters.delete(check); resolve() } }
    waiters.add(check)
    check()
  }))
  let permissions = 0
  yield* runtime.handleRequestPermission(() => {
    permissions++
    for (const check of waiters) check()
    return Effect.succeed({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
  })
  yield* runtime.getEvents().pipe(Stream.runForEach(event => {
    if (event._tag === 'EventStreamBarrier') return Deferred.succeed(event.acknowledge, undefined)
    events.push(event)
    for (const check of waiters) check()
    return Effect.void
  }), Effect.forkChild)
  const started = yield* runtime.start()
  assert.equal(started.initializeResult.protocolVersion, 2)
  yield* runtime.prompt({ prompt: [{ type: 'text', text: 'exercise the attached server' }] })
  yield* runtime.drainEvents
  yield* waitFor(() => events.some(event => event._tag === 'ContentDelta' && event.text.includes('model=alpha; tool=5')))
  yield* runtime.drainEvents
  assert(events.some(event => event._tag === 'ContentDelta' && event.text.includes('model=alpha; tool=5')))
  assert(events.some(event => event._tag === 'ToolCallUpdated'))
  const command = text => runtime.prompt({ prompt: [{ type: 'text', text }] })
  const goalRun = yield* command('/goal finish the interoperability task').pipe(Effect.forkChild)
  yield* waitFor(() => permissions === 1)
  yield* runtime.cancel
  yield* Fiber.join(goalRun)
  yield* command('/goal pause')
  yield* runtime.drainEvents
  assert(events.some(event => event._tag === 'ContentDelta' && event.text.includes('Goal paused')))
  assert(events.some(event => event._tag === 'PlanUpdated'))
  const resumedRun = yield* command('/goal resume').pipe(Effect.forkChild)
  yield* waitFor(() => permissions === 2)
  yield* runtime.cancel
  yield* Fiber.join(resumedRun)
  yield* command('/goal')
  yield* runtime.drainEvents
  const sessionId = started.sessionId
  yield* runtime.closeSession(sessionId)
  const loaded = yield* runtime.loadSession(sessionId)
  assert.equal(loaded.sessionId, sessionId)
  yield* runtime.drainEvents
  yield* command('/goal clear')
  yield* runtime.closeSession(sessionId)
  process.stdout.write(JSON.stringify({ goals: true, permissions, loaded: true, protocolVersion: started.initializeResult.protocolVersion, events: [...new Set(events.map(event => event._tag))] }) + '\n')
// Leave time for scoped child-process teardown before execFile's outer deadline.
}).pipe(Effect.timeout('25 seconds'), Effect.scoped, Effect.provide(NodeServices.layer)))
