/** Browser-safe addresses and results for destination-owned workspace operations. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** An installation retained in the catalog even when its route is unavailable. */
export interface EnvironmentTarget {
  environmentId: Branded<'EnvironmentId'>
  label: string
  local: boolean
  status: 'online' | 'unavailable' | 'unsupported'
}

/** A workspace identifier is meaningful only together with its owning installation. */
export interface EnvironmentWorkspace {
  environmentId: Branded<'EnvironmentId'>
  workspaceId: Branded<'WorkspaceId'>
  alias: string
  relativePath: string
  path: string
  title: string
}

/** Operations use slash-separated paths relative to a destination's configured alias. */
export type WorkspaceRequest =
  | { action: 'catalog' }
  | { action: 'browse' | 'register'; alias: string; relativePath: string }
  | { action: 'mkdir'; alias: string; relativePath: string; name: string }

/** Bounded destination-owned data; truncation is explicit instead of looking like an empty folder. */
export type WorkspaceResult =
  | { kind: 'catalog'; roots: { alias: string; path: string }[]; workspaces: EnvironmentWorkspace[]; truncated: boolean }
  | { kind: 'directory'; alias: string; relativePath: string; path: string; entries: { name: string; relativePath: string }[]; truncated: boolean }
  | { kind: 'registered'; workspace: EnvironmentWorkspace }
