/** Wire validation for workspace requests and complete bounded responses. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { EnvironmentWorkspace, WorkspaceRequest, WorkspaceResult } from './workspace-types.ts'

const alias = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u)
const relativePath = z.string().refine(value => value === '' || value.split('/').every(segment =>
  segment !== '' && segment !== '.' && segment !== '..' && !/[\\:\u0000]/u.test(segment)), 'path must stay relative to its granted directory')
const name = relativePath.refine(value => value !== '' && !value.includes('/'), 'folder name must be one path segment')

/** Reject absolute paths, traversal, and malformed actions before filesystem access. */
export const workspaceRequestSchema: z.ZodType<WorkspaceRequest> = z.discriminatedUnion('action', [
  z.object({ action: z.literal('catalog') }).strict(),
  z.object({ action: z.enum(['browse', 'register']), alias, relativePath }).strict(),
  z.object({ action: z.literal('mkdir'), alias, relativePath, name }).strict(),
])
const workspace = z.object({
  environmentId: z.uuid().transform(value => brandString<EnvironmentWorkspace['environmentId']>(value)),
  workspaceId: z.string().min(1).transform(value => brandString<EnvironmentWorkspace['workspaceId']>(value)),
  alias, relativePath, path: z.string(), title: z.string(),
}).strict()

/** Validate data returned by another installation before showing it to the operator. */
export const workspaceResultSchema: z.ZodType<WorkspaceResult> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('catalog'), roots: z.array(z.object({ alias, path: z.string() }).strict()), workspaces: z.array(workspace), truncated: z.boolean() }).strict(),
  z.object({ kind: z.literal('directory'), alias, relativePath, path: z.string(), entries: z.array(z.object({ name, relativePath }).strict()), truncated: z.boolean() }).strict(),
  z.object({ kind: z.literal('registered'), workspace }).strict(),
])
