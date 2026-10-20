import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(import.meta.dirname, ['lib/types/index.js', 'lib/types/management.js', 'lib/types/pairing.js'], { hostPhase: true })
