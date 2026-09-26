/** Save feedback owned by the shell, so it survives configuration-page navigation. */
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'

/** Last completed operator save. */
export interface NoticeState { kind: 'saved' | 'saveFailed' | null; sequence: number }
/** Notification state and acknowledgement supplied by the plugin owner. */
export interface NoticeFace { hooks: { environmentNotice: SnapshotStore<NoticeState> }; dismiss(): void }

/** Render the latest save result in the global toast layer.
 * @param props - typed locale and owner-held notification state.
 * @returns a toast while a completed save has feedback.
 */
export function Notice(props: PropsLocale<'environmentTeams'> & InjectFace<NoticeFace>) {
  const state = props.useEnvironmentNotice(value => value)
  return state.kind === null ? null : <Toast key={state.sequence} text={props.t(state.kind)} {...state.kind === 'saved' ? { tone: 'success' as const } : {}} onDone={props.dismiss} />
}
