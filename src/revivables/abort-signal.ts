import type { Capable } from '../types.js'
import type { RevivableContext, BoxBase as BoxBaseType } from './utils.js'
import type { BoxedMessagePort } from './message-port.js'

import { BoxBase } from './utils.js'
import { recursiveBox, recursiveRevive } from './index.js'
import { onTeardown } from '../utils/teardown.js'
import {
  createRevivableChannel,
  revive as reviveMessagePort,
  AnyPort,
} from './message-port.js'

export const type = 'abortSignal' as const

/** Never claims a primitive, so the walker can skip this module for primitive leaves. */
export const objectsOnly = true

type AbortMessage = {
  type: 'abort'
  reason?: Capable
}

export type BoxedAbortSignal =
  & BoxBaseType<typeof type>
  & {
    aborted: boolean
    reason?: Capable
    /** Absent when the signal was already aborted at box time - the reason
     *  rides the wrapper and no live channel is needed. */
    port?: BoxedMessagePort<AbortMessage>
  }

export const isType = (value: unknown): value is AbortSignal =>
  value instanceof AbortSignal

// Pins the revived port while the revived signal is reachable - a GC of it would silently sever abort propagation.
const revivedPortPins = new WeakMap<AbortSignal, AnyPort<AbortMessage>>()

export const box = <T extends AbortSignal, T2 extends RevivableContext>(
  value: T,
  context: T2,
): BoxedAbortSignal => {
  // Must box the reason here - recursiveBox short-circuits on OSRA_BOX without descending in.
  if (value.aborted) {
    return {
      ...BoxBase,
      type,
      aborted: true,
      reason: recursiveBox(value.reason as Capable, context) as Capable,
    }
  }

  const { localPort, boxedRemote } = createRevivableChannel<AbortMessage>(context)

  const onSourceAbort = () => {
    localPort.postMessage({ type: 'abort', reason: value.reason as Capable })
    localPort.close()
    removeTeardown()
  }
  const removeTeardown = onTeardown(context, () => {
    value.removeEventListener('abort', onSourceAbort)
    localPort.close()
  })
  value.addEventListener('abort', onSourceAbort, { once: true })

  return {
    ...BoxBase,
    type,
    aborted: false,
    reason: undefined,
    port: boxedRemote,
  }
}

export const revive = <T extends BoxedAbortSignal, T2 extends RevivableContext>(
  value: T,
  context: T2,
): AbortSignal => {
  const controller = new AbortController()

  if (value.aborted || value.port === undefined) {
    controller.abort(recursiveRevive(value.reason as Capable, context))
    return controller.signal
  }

  const port = reviveMessagePort(value.port, context)
  revivedPortPins.set(controller.signal, port)
  port.start()

  port.addEventListener('message', ({ data: message }) => {
    if (message.type === 'abort') {
      controller.abort(recursiveRevive(message.reason as Capable, context))
      revivedPortPins.delete(controller.signal)
      port.close()
    }
  })

  return controller.signal
}

const typeCheck = () => {
  const boxed = box(new AbortController().signal, {} as RevivableContext)
  const revived = revive(boxed, {} as RevivableContext)
  const expected: AbortSignal = revived
  // @ts-expect-error - not an AbortSignal
  const notAbortSignal: string = revived
  // @ts-expect-error - cannot box non-AbortSignal
  box('not an abort signal', {} as RevivableContext)
}
