import type { Capable } from '../types.js'
import type { RevivableContext } from './utils.js'
import type { RevivableModule } from './index.js'

import { recursiveBox } from './index.js'

/** The state of one box walk, the boxing of one message. Boxing is fully synchronous, so the walk on
 *  top of the stack is the one every nested `recursiveBox` call belongs to. */
export type BoxWalk = {
  /** Values on the current path, so a cycle throws while sibling aliasing still works. */
  readonly path: WeakSet<object>
  /** How many `transfer()` wrappers are being boxed around the current value. */
  transferDepth: number
  /** Quote osra's own boxes too: the payload is another walk's output, relayed as user data. */
  readonly quoteAll: boolean
  readonly effects: Array<{ commit: () => void, rollback: () => void }>
}

let current: BoxWalk | undefined

export const currentWalk = (): BoxWalk | undefined => current

const settle = (walk: BoxWalk, failed: boolean): void => {
  for (const effect of walk.effects) {
    try {
      if (failed) effect.rollback()
      else effect.commit()
    } catch { /* one module's bookkeeping must not break another's */ }
  }
}

/** Box `value` as a message of its own: a fresh cycle path, transfer extent and set of pending side
 *  effects, whatever walk is on the stack. Every place osra starts boxing a message calls this, since
 *  one can fire synchronously inside another walk (an `EventPort.start()` flush, a getter calling a
 *  revived function) without being part of that walk's message. */
export const boxMessage = <TModules extends readonly RevivableModule[]>(
  value: Capable,
  context: RevivableContext<TModules>,
  { quoteAll = false }: { quoteAll?: boolean } = {},
): Capable => {
  const saved = current
  const walk: BoxWalk = { path: new WeakSet(), transferDepth: 0, quoteAll, effects: [] }
  current = walk
  let failed = true
  try {
    const boxed = recursiveBox(value, context) as Capable
    failed = false
    return boxed
  } finally {
    current = saved
    settle(walk, failed)
  }
}

/** Hold a side effect until the whole box walk this value belongs to has finished, and undo it if the
 *  walk throws. A module that records state the PEER will be told about ("it knows this id now") must
 *  not keep that record when a later sibling breaks the message it was recorded for: nothing ships,
 *  and every later send would then reference something the peer never received. Outside a walk the
 *  effect is already settled, so `commit` runs immediately. */
export const onBoxWalkSettled = (commit: () => void, rollback: () => void): void => {
  if (current) current.effects.push({ commit, rollback })
  else commit()
}
