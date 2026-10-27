// A thread visit owns its choices. A stream conversation can seed a new visit
// with a detached copy before the thread mounts; Back reuses the existing view.
import { getContext, setContext } from 'svelte'
import type { ChainInfo, MessageRecord } from '../../lib/types'
import { router } from '../navigation/router.svelte'
import { copyReplySessions, type ReplySessions } from './replies'
import type { ReplyViews } from './stream-expansion'

type ThreadView = { sessions: ReplySessions; ancestors: MessageRecord[]; branches: ReplyViews; repliesOpen: boolean; openAncestors: Record<string, boolean> }

export function threadView(chain: ChainInfo, id: bigint, branches: ReplyViews = new Map()): ThreadView {
  return router.visit.state<ThreadView>(`thread/${chain.id}/${chain.contract}/${id}`, () => ({
    sessions: new Map(), ancestors: [], branches, repliesOpen: true, openAncestors: {},
  }), view => ({
    sessions: copyReplySessions(view.sessions), ancestors: [...view.ancestors],
    repliesOpen: view.repliesOpen, openAncestors: { ...view.openAncestors },
    branches: new Map([...view.branches].map(([id, branch]) => [id, {
      limit: branch.limit, open: { ...branch.open }, retained: branch.retained ? [...branch.retained] : undefined,
    }])),
  }))
}

const OPEN_THREAD = Symbol('stream-thread-opener')
type ThreadOpener = (id: bigint) => void

/** Every card in a stream conversation, including loaded branches, shares its handoff. */
export function provideThreadOpener(open: ThreadOpener): void { setContext(OPEN_THREAD, open) }
export function threadOpener(): ThreadOpener | undefined { return getContext(OPEN_THREAD) }
