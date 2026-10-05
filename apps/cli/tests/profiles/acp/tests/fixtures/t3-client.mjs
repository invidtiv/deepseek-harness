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
const NodeServices = await load('@effect/platform-node/NodeServices')
const Runtime = await import(pathToFileURL(join(root, 'apps/server/src/provider/acp/AcpSessionRuntime.ts')).href)
const options = JSON.parse(await readFile(optionsFile, 'utf8'))

await Effect.runPromise(Effect.gen(function* () {
  const runtime = yield* Runtime.make(options)
  const events = []
  yield* runtime.getEvents().pipe(Stream.runForEach(event => {
    if (event._tag === 'EventStreamBarrier') return Deferred.succeed(event.acknowledge, undefined)
    events.push(event)
    return Effect.void
  }), Effect.forkChild)
  const started = yield* runtime.start()
  assert.equal(started.initializeResult.protocolVersion, 1)
  const result = yield* runtime.prompt({ prompt: [{ type: 'text', text: 'exercise the attached server' }] })
  yield* runtime.drainEvents
  assert.equal(result.stopReason, 'end_turn')
  assert(events.some(event => event._tag === 'ContentDelta' && event.text.includes('model=alpha; tool=5')))
  assert(events.some(event => event._tag === 'ToolCallUpdated'))
  process.stdout.write(JSON.stringify({ protocolVersion: 1, stopReason: result.stopReason, events: [...new Set(events.map(event => event._tag))] }) + '\n')
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
