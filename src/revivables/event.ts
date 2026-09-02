import type { Capable } from '../types.js'
import type { RevivableContext, BoxBase as BoxBaseType } from './utils.js'

import { BoxBase } from './utils.js'
import { recursiveBox, recursiveRevive } from './index.js'

export const type = 'event' as const

/** Never claims a primitive, so the walker can skip this module for primitive leaves. */
export const objectsOnly = true

/** Boxes Event/CustomEvent only. Subclass-specific fields (MessageEvent.data,
 *  ErrorEvent.error, ProgressEvent.loaded, etc.) are dropped on the wire. */
export type BoxedEvent =
  & BoxBaseType<typeof type>
  & { eventType: string, bubbles: boolean, cancelable: boolean, composed: boolean, detail?: Capable }

export const isType = (value: unknown): value is Event =>
  value instanceof Event

export const box = <T extends Event, T2 extends RevivableContext>(
  value: T,
  context: T2,
): BoxedEvent => ({
  ...BoxBase,
  type,
  eventType: value.type,
  bubbles: value.bubbles,
  cancelable: value.cancelable,
  composed: value.composed,
  ...(value instanceof CustomEvent ? { detail: recursiveBox(value.detail as Capable, context) as Capable } : {}),
})

export const revive = <T extends BoxedEvent, T2 extends RevivableContext>(
  value: T,
  context: T2,
): Event => {
  const init = { bubbles: value.bubbles, cancelable: value.cancelable, composed: value.composed }
  return 'detail' in value
    ? new CustomEvent(value.eventType, { ...init, detail: recursiveRevive(value.detail as Capable, context) })
    : new Event(value.eventType, init)
}

const typeCheck = () => {
  const boxed = box(new Event('foo'), {} as RevivableContext)
  const revived = revive(boxed, {} as RevivableContext)
  const expected: Event = revived
  // @ts-expect-error - not an Event
  const notEvent: string = revived
  // @ts-expect-error - cannot box non-Event
  box('not an event', {} as RevivableContext)
}
