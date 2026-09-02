import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { telegramTopicsDomain, TopicRegistry, topicKeyOf } from '../src/topics.ts'
import {
  ALLOWED_USER,
  documentUpdate,
  FORUM_TOPIC,
  GENERAL_TOPIC,
  makeTelegramHarness,
  photoUpdate,
  textResponse,
  textUpdate,
  topicCreatedUpdate,
  type TelegramHarness,
  type TestTopic,
} from './harness.ts'
import type { Update } from '../src/types.ts'

function waitFor(assertion: () => void): Promise<void> {
  return vi.waitFor(assertion, { timeout: 8000, interval: 25 })
}

function settled(): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, 100))
}

/** A message update carrying only the given fields beyond chat and sender. */
function messageUpdate(updateId: number, topic: TestTopic, fields: Record<string, unknown>): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: topic.chatId, type: 'supergroup', is_forum: true },
      ...topic.threadId !== null ? { message_thread_id: topic.threadId } : {},
      from: { id: ALLOWED_USER, is_bot: false, first_name: 'tester' },
      ...fields,
    },
  }
}

/** The live mapping registry of a mounted plugin, for external tampering. */
function externalRegistry(harness: TelegramHarness): TopicRegistry {
  const domain = harness.ctx.storageDomain.get('telegram_topics')
  if (domain === undefined) throw new Error('the plugin has no open mapping domain')
  return new TopicRegistry(domain as unknown as Domain<typeof telegramTopicsDomain>)
}

/** Two roots leave the workspace choice to `/folder`, so nothing is admitted by default. */
async function twoRoots(): Promise<string[]> {
  return [
    await mkdtemp(join(tmpdir(), 'telegram-root-a-')),
    await mkdtemp(join(tmpdir(), 'telegram-root-b-')),
  ]
}

describe('Telegram update routing', () => {
  let harness: TelegramHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('ignores carriers and messages that address no session', async () => {
    harness = await makeTelegramHarness({ script: [textResponse('unused')] })
    await harness.api.waitForPoll()
    harness.api.push({
      update_id: 1,
      edited_message: {
        message_id: 1,
        chat: { id: GENERAL_TOPIC.chatId },
        from: { id: ALLOWED_USER, is_bot: false, first_name: 'tester' },
        text: 'fixed typo',
      },
    })
    harness.api.push(messageUpdate(2, GENERAL_TOPIC, { sticker: { file_id: 's1' } }))
    harness.api.push(messageUpdate(3, GENERAL_TOPIC, { text: '   ' }))
    await settled()
    expect(harness.api.texts()).toHaveLength(0)
    expect(harness.ctx.agents.list()).toHaveLength(0)
    expect(harness.adapter.requests).toHaveLength(0)
  })

  it('pauses output for a closed topic without stopping the session', async () => {
    harness = await makeTelegramHarness({ script: [textResponse('answered while closed')] })
    await harness.api.waitForPoll()
    harness.api.push(messageUpdate(1, GENERAL_TOPIC, { forum_topic_closed: {} }))
    harness.api.push(textUpdate(2, GENERAL_TOPIC, 'still working?'))
    await waitFor(() => {
      expect(harness?.adapter.requests ?? []).toHaveLength(1)
    })
    await settled()
    expect(harness.api.texts()).toHaveLength(0)
    expect(harness.ctx.agents.list()).toHaveLength(1)
  })

  it('records a renamed topic without creating a session', async () => {
    harness = await makeTelegramHarness()
    await harness.api.waitForPoll()
    harness.api.push(topicCreatedUpdate(1, FORUM_TOPIC, 'API Work'))
    harness.api.push(topicCreatedUpdate(2, FORUM_TOPIC, 'API Work v2'))
    const key = topicKeyOf(FORUM_TOPIC.chatId, FORUM_TOPIC.threadId)
    await waitFor(() => {
      expect(externalRegistry(harness as TelegramHarness).get(key)?.topicTitle).toBe('API Work v2')
    })
    expect(harness.ctx.agents.list()).toHaveLength(0)
  })

  it('admits every update id once and keeps the dedupe window bounded', async () => {
    harness = await makeTelegramHarness({ script: [textResponse('once')] })
    await harness.api.waitForPoll()
    const first = textUpdate(1, GENERAL_TOPIC, 'hello')
    harness.api.push(first)
    harness.api.push(first)
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('once')
    })
    expect(harness.adapter.requests).toHaveLength(1)

    // Overflow the window with updates from an unauthorized chat, then prove
    // the loop still routes the next authorized message.
    for (let index = 0; index < 1100; index += 1) {
      harness.api.push({
        update_id: 1000 + index,
        message: {
          message_id: 1,
          chat: { id: 4242 },
          from: { id: ALLOWED_USER, is_bot: false, first_name: 'tester' },
          text: 'not for us',
        },
      })
    }
    harness.api.push(textUpdate(9000, GENERAL_TOPIC, '/help'))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('/folder [path]')
    })
  }, 20000)

  it('warns instead of failing when an update handler throws', async () => {
    harness = await makeTelegramHarness()
    await harness.api.waitForPoll()
    harness.api.failNext(new Error('telegram is unreachable'))
    harness.api.push(textUpdate(1, GENERAL_TOPIC, '/status'))
    harness.api.push(textUpdate(2, GENERAL_TOPIC, '/help'))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('/folder [path]')
    })
  })
})

describe('Telegram commands over the runtime', () => {
  let harness: TelegramHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('asks for a session when a command needs one', async () => {
    harness = await makeTelegramHarness()
    await harness.api.waitForPoll()
    harness.api.push(textUpdate(1, GENERAL_TOPIC, '/status'))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('Command /status needs a session')
    })
    expect(harness.ctx.agents.list()).toHaveLength(0)
  })

  it('reports commands as unavailable without the commands runtime', async () => {
    harness = await makeTelegramHarness({ commands: false, script: [textResponse('hello back')] })
    await harness.api.waitForPoll()
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'hello'))
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('hello back')
    })
    harness.api.push(textUpdate(2, GENERAL_TOPIC, '/status'))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('the commands runtime is not mounted')
    })
  })

  it('replies with an error for an unknown slash command instead of forwarding to the model', async () => {
    harness = await makeTelegramHarness({ script: [textResponse('started')] })
    await harness.api.waitForPoll()
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'hello'))
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('started')
    })
    harness.api.push(textUpdate(2, GENERAL_TOPIC, '/deploy now'))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('Unknown command /deploy')
    })
    expect(harness.adapter.requests).toHaveLength(1)
  })

  it('renders a silent command result and a failing command', async () => {
    harness = await makeTelegramHarness({ script: [textResponse('ready')] })
    await harness.api.waitForPoll()
    harness.ctx.commands.register({
      name: 'quiet',
      description: 'Answer without text',
      handler: () => ({ kind: 'success' }),
    })
    harness.ctx.commands.register({
      name: 'boom',
      description: 'Fail on purpose',
      handler: () => { throw new Error('handler exploded') },
    })
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'hello'))
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('ready')
    })
    harness.api.push(textUpdate(2, GENERAL_TOPIC, '/quiet'))
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('')
    })
    harness.api.push(textUpdate(3, GENERAL_TOPIC, '/boom'))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('Command /boom failed: Error: handler exploded')
    })
  })
})

describe('Telegram workspace admission', () => {
  let harness: TelegramHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('refuses every message until a topic picks one of several roots', async () => {
    harness = await makeTelegramHarness({ workspaceRoots: await twoRoots() })
    await harness.api.waitForPoll()
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'hello'))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('No workspace selected for this topic')
    })
    harness.api.push(textUpdate(2, GENERAL_TOPIC, 'hello again'))
    await waitFor(() => {
      expect(harness?.api.texts().filter(text => text.includes('No workspace selected'))).toHaveLength(2)
    })
    expect(harness.ctx.agents.list()).toHaveLength(0)
  })

  it('creates the first session in the configured default workspace', async () => {
    const roots = await twoRoots()
    const preferred = join(roots[0] as string, 'preferred')
    await mkdir(preferred)
    harness = await makeTelegramHarness({
      workspaceRoots: roots,
      config: { defaultWorkspace: preferred },
      script: [textResponse('in the default folder')],
    })
    await harness.api.waitForPoll()
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'hello'))
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('in the default folder')
    })
    expect(harness.ctx.agents.list()[0]?.session.header.cwd).toBe(preferred)
  })

  it('refuses admission when the default workspace disappeared after startup', async () => {
    const roots = await twoRoots()
    const preferred = join(roots[0] as string, 'preferred')
    await mkdir(preferred)
    harness = await makeTelegramHarness({ workspaceRoots: roots, config: { defaultWorkspace: preferred } })
    await harness.api.waitForPoll()
    await mkdir(join(roots[0] as string, 'moved'))
    await rm(preferred, { recursive: true })
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'hello'))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('No workspace selected for this topic')
    })
    expect(harness.ctx.agents.list()).toHaveLength(0)
  })

  it('refuses admission when the mapping store cannot be written', async () => {
    harness = await makeTelegramHarness()
    await harness.api.waitForPoll()
    const domain = harness.ctx.storageDomain.get('telegram_topics')
    await domain?.close()
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'hello'))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('Session admission failed')
    })
    expect(harness.ctx.agents.list()).toHaveLength(0)
  })

  it('applies the default cadence, timeout, and queue settings', async () => {
    harness = await makeTelegramHarness({
      script: ['hang'],
      omitConfig: ['pollTimeoutMs', 'editIntervalMs', 'approvalTimeoutMs', 'queueCap'],
    })
    await harness.api.waitForPoll()
    for (let index = 1; index <= 5; index += 1) {
      harness.api.push(textUpdate(index, GENERAL_TOPIC, `message ${index}`))
    }
    await waitFor(() => {
      expect(harness?.api.texts().some(text => text.startsWith('Busy'))).toBe(true)
    })
  })
})

describe('Telegram photo ingestion', () => {
  let harness: TelegramHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('maps each downloaded photo path to its attachment media type', async () => {
    harness = await makeTelegramHarness({ attachments: true, imageCapable: true, script: ['hang'] })
    const paths = [
      ['p1', 'photos/a.png'],
      ['p2', 'photos/b.webp'],
      ['p3', 'photos/c.gif'],
      ['p4', 'photos/plain'],
    ] as const
    for (const [fileId, path] of paths) harness.api.registerFile(fileId, path, new Uint8Array([1, 2, 3]))
    await harness.api.waitForPoll()
    for (const [index, [fileId]] of paths.entries()) {
      harness.api.push(photoUpdate(index + 1, GENERAL_TOPIC, fileId))
    }
    await waitFor(() => {
      expect(harness?.attachments?.saved ?? []).toHaveLength(4)
    })
    expect(harness.attachments?.saved.map(saved => saved.mediaType)).toEqual([
      'image/png',
      'image/webp',
      'image/gif',
      'image/jpeg',
    ])
  })

  it('refuses a photo before the topic has a workspace', async () => {
    harness = await makeTelegramHarness({
      attachments: true,
      imageCapable: true,
      workspaceRoots: await twoRoots(),
    })
    await harness.api.waitForPoll()
    harness.api.registerFile('p1', 'photos/a.png', new Uint8Array([1]))
    harness.api.push(photoUpdate(1, GENERAL_TOPIC, 'p1'))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('No workspace selected for this topic')
    })
    expect(harness.attachments?.saved).toHaveLength(0)
  })

  it('reports a photo Telegram will not hand over', async () => {
    harness = await makeTelegramHarness({ attachments: true, imageCapable: true, script: ['hang'] })
    await harness.api.waitForPoll()
    harness.api.push(photoUpdate(1, GENERAL_TOPIC, 'unregistered'))
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('Could not download that photo.')
    })
  })

  it('reports a failed photo download', async () => {
    harness = await makeTelegramHarness({ attachments: true, imageCapable: true, script: ['hang'] })
    await harness.api.waitForPoll()
    harness.api.registerFile('p1', 'photos/a.png', new Uint8Array([1]))
    harness.api.failNextDownload(new Error('download interrupted'))
    harness.api.push(photoUpdate(1, GENERAL_TOPIC, 'p1'))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('Photo ingestion failed: Error: download interrupted')
    })
  })

  it('refuses photos when the deployment declares no model route', async () => {
    harness = await makeTelegramHarness({ attachments: true, omitConfig: ['agentOptions'] })
    await harness.api.waitForPoll()
    harness.api.push(photoUpdate(1, GENERAL_TOPIC, 'p1'))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('Photos are not supported by this deployment')
    })
  })

  it('refuses photos when the configured route cannot be resolved', async () => {
    harness = await makeTelegramHarness({
      attachments: true,
      config: { agentOptions: { provider: 'nope', model: 'nope' } },
    })
    await harness.api.waitForPoll()
    harness.api.push(photoUpdate(1, GENERAL_TOPIC, 'p1'))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('Photos are not supported by this deployment')
    })
  })
})

describe('Telegram document ingestion', () => {
  let harness: TelegramHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('refuses a document above the bot download limit', async () => {
    harness = await makeTelegramHarness()
    await harness.api.waitForPoll()
    harness.api.push(messageUpdate(1, GENERAL_TOPIC, {
      document: { file_id: 'big', file_unique_id: 'big', file_name: 'big.bin', file_size: 21 * 1024 * 1024 },
    }))
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('That document exceeds the 20 MB bot limit.')
    })
  })

  it('stores a document that declares no size or name under a safe file name', async () => {
    harness = await makeTelegramHarness({ script: ['hang'] })
    harness.api.registerFile('d1', 'documents/a.bin', new Uint8Array([1, 2]))
    harness.api.registerFile('d2', 'documents/b.bin', new Uint8Array([3]))
    await harness.api.waitForPoll()
    harness.api.push(messageUpdate(1, GENERAL_TOPIC, { document: { file_id: 'd1', file_unique_id: 'd1' } }))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('Saved _telegram_inbox/document-1')
    })
    harness.api.push(messageUpdate(2, GENERAL_TOPIC, {
      document: { file_id: 'd2', file_unique_id: 'd2', file_name: '.' },
    }))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('Saved _telegram_inbox/document-2')
    })
  })

  it('refuses a document before the topic has a workspace', async () => {
    harness = await makeTelegramHarness({ workspaceRoots: await twoRoots() })
    await harness.api.waitForPoll()
    harness.api.push(documentUpdate(1, GENERAL_TOPIC, 'd1', 'notes.txt'))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('No workspace selected for this topic')
    })
  })

  it('reports a topic whose mapping row lost its workspace', async () => {
    harness = await makeTelegramHarness({ script: ['hang'] })
    await harness.api.waitForPoll()
    harness.api.push(textUpdate(1, GENERAL_TOPIC, 'hello'))
    await waitFor(() => {
      expect(harness?.adapter.requests ?? []).toHaveLength(1)
    })
    const key = topicKeyOf(GENERAL_TOPIC.chatId, null)
    const registry = externalRegistry(harness)
    const row = registry.get(key)
    if (row === undefined) throw new Error('expected a mapping row')
    await registry.put(key, { ...row, workspace: null, pendingWorkspace: null })
    harness.api.push(documentUpdate(2, GENERAL_TOPIC, 'd1', 'notes.txt'))
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('No workspace selected for this topic.')
    })
  })

  it('reports a document Telegram will not hand over', async () => {
    harness = await makeTelegramHarness({ script: ['hang'] })
    await harness.api.waitForPoll()
    harness.api.push(documentUpdate(1, GENERAL_TOPIC, 'unregistered', 'notes.txt'))
    await waitFor(() => {
      expect(harness?.api.texts()).toContain('Could not download that document.')
    })
  })

  it('reports a document that cannot be written into the inbox', async () => {
    harness = await makeTelegramHarness({ script: ['hang'] })
    // A file where the inbox directory belongs makes the download unstorable.
    await writeFile(join(harness.roots[0] as string, '_telegram_inbox'), 'occupied')
    harness.api.registerFile('d1', 'documents/a.txt', new Uint8Array([1]))
    await harness.api.waitForPoll()
    harness.api.push(documentUpdate(1, GENERAL_TOPIC, 'd1', 'notes.txt'))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('Document ingestion failed')
    })
  })

  it('reports a failed document download', async () => {
    harness = await makeTelegramHarness({ script: ['hang'] })
    harness.api.registerFile('d1', 'documents/a.txt', new Uint8Array([1]))
    harness.api.failNextDownload(new Error('download interrupted'))
    await harness.api.waitForPoll()
    harness.api.push(documentUpdate(1, GENERAL_TOPIC, 'd1', 'notes.txt'))
    await waitFor(() => {
      expect(harness?.api.texts().join('\n')).toContain('Document ingestion failed: Error: download interrupted')
    })
  })
})
