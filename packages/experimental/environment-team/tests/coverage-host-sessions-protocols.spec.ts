/** JSON validation of interaction results and team dashboard operations. */
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { interactionResultSchema } from '../src/interaction-protocol.ts'
import { teamDashboardRequestSchema, teamDashboardResultSchema } from '../src/team-dashboard-protocol.ts'

const environmentId = randomUUID()
const scope = { environmentId, workspaceId: 'workspace', sessionId: 'session' }

it('accepts an upload receipt and rejects unknown fields in it', () => {
  const uploaded = { ...scope, kind: 'uploaded', upload: { receiptId: 'receipt', file: { attachmentId: 'attachment', name: 'review.txt', bytes: 17 } } }
  expect(interactionResultSchema.parse(uploaded)).toEqual(uploaded)
  expect(() => interactionResultSchema.parse({ ...uploaded, upload: { ...uploaded.upload, path: '/etc/passwd' } })).toThrow()
})

it('accepts tool call identities in snapshot details', () => {
  const snapshot = { ...scope, kind: 'snapshot', pending: [], attachments: [], terminals: [], capabilities: { attachments: true, approvals: true, terminals: true }, maxUploadBytes: 10, terminalCols: 80, terminalRows: 24, truncated: false,
    details: [{ seq: 1, kind: 'tool-call', title: 'read_file', text: '{}', callId: 'call-1', isError: false }] }
  expect(interactionResultSchema.parse(snapshot)).toEqual(snapshot)
})

it('accepts operator requests that name a team and rejects extra fields', () => {
  const read = { action: 'read', teamId: 'team-1' }
  expect(teamDashboardRequestSchema.parse(read)).toEqual(read)
  const interrupt = { action: 'interrupt', teamId: 'team-1', sessionId: 'session-1' }
  expect(teamDashboardRequestSchema.parse(interrupt)).toEqual(interrupt)
  expect(() => teamDashboardRequestSchema.parse({ ...read, body: 'private' })).toThrow()
})

it('accepts catalog, team and interruption results without message bodies', () => {
  const catalog = { kind: 'catalog', environmentId, teams: [{ teamId: 'team-1', workspace: 'project', members: 2, tasks: 1, queuedMessages: 0 }] }
  expect(teamDashboardResultSchema.parse(catalog)).toEqual(catalog)
  const team = { kind: 'team', environmentId, teamId: 'team-1', workspace: 'project',
    members: [{ environmentId, sessionId: 'session-1', name: 'worker', workspace: 'project' }],
    tasks: [{ id: 'task-1', text: 'review', revision: 1, status: 'pending', owner: 'worker' }],
    outbox: [{ id: 'message-1', sender: 'lead', target: 'worker' }] }
  expect(teamDashboardResultSchema.parse(team)).toEqual(team)
  expect(() => teamDashboardResultSchema.parse({ ...team, outbox: [{ id: 'message-1', sender: 'lead', target: 'worker', text: 'private' }] })).toThrow()
  const interrupted = { kind: 'interrupted', environmentId, teamId: 'team-1', sessionId: 'session-1', status: 'inactive' }
  expect(teamDashboardResultSchema.parse(interrupted)).toEqual(interrupted)
})
