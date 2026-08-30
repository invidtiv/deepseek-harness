/**
 * Type declarations for the plain-JavaScript Bot API mock used by the
 * keyless smoke (`./mock-telegram-server.mjs`).
 */

export interface MockUpdate {
  readonly update_id: number
  readonly message?: {
    readonly message_id: number
    readonly chat: { readonly id: number }
    readonly from?: { readonly id: number; readonly is_bot?: boolean; readonly first_name?: string }
    readonly text?: string
  }
  readonly callback_query?: unknown
}

export class MockTelegramServer {
  static start(): Promise<MockTelegramServer>
  get url(): string
  waitForFirstPoll(): Promise<void>
  pushUpdate(update: MockUpdate): void
  texts(): string[]
  seenPaths(): string[]
  close(): Promise<void>
}
