/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-file-explorer`.
 * @module @deepseek-ai/dsh-client-ui-file-explorer/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-file-explorer'

/** Cordis companion plugin name. */
export const name = 'client-ui-file-explorer-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the slot and dictionary registrations are effect-owned
 * with disposal proven by their plugin specs; directory listings flow through
 * the runtime's workspaces contract and this package owns no mutable state
 * outside those fibers.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
