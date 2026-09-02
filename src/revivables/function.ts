import type { Capable } from '../types.js'
import type { UnderlyingType, RevivableContext, BoxBase as BoxBaseType } from './utils.js'

import { BoxBase } from './utils.js'
import { outsideTransfer } from './transfer.js'
import { recursiveBox } from './index.js'
import { EventChannel, type EventPort } from '../utils/event-channel.js'
import { isTornDown, onTeardown } from '../utils/teardown.js'
import { box as boxMessagePort, postPreBoxed, revive as reviveMessagePort, BoxedMessagePort } from './message-port.js'

export const type = 'function' as const

type ResultMessage =
  | { type: 'return', value: Capable }
  | { type: 'throw', error: Capable }

type CallContext = [EventPort<Capable>, Capable[]]

// Pins return-value ports between call-site return and result arrival - the cycle has no other anchor.
const inFlightReturnPorts = new Set<EventPort<Capable>>()

/** Releases a result the peer can never receive. Top level and best effort ON PURPOSE: walking into the
 *  value is what boxing does, and boxing into a dead context is the thing the caller is avoiding. */
const disposeUndelivered = (value: unknown): void => {
  if (value instanceof ReadableStream) {
    if (!value.locked) value.cancel(new Error('osra: connection closed')).catch(() => {})
  } else if (typeof WritableStream !== 'undefined' && value instanceof WritableStream) {
    if (!value.locked) value.abort(new Error('osra: connection closed')).catch(() => {})
  }
}

export type BoxedFunction<T extends (...args: any[]) => any = (...args: any[]) => any> =
  & BoxBaseType<typeof type>
  & { port: BoxedMessagePort<CallContext> }
  & { [UnderlyingType]: (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>> }

type CapableFunction<T> = T extends (...args: infer P) => infer R
  ? P extends Capable[]
    ? R extends Capable ? T : never
    : never
  : never

export const isType = (value: unknown): value is (...args: any[]) => any =>
  typeof value === 'function'

export const box = <T extends (...args: any[]) => any, T2 extends RevivableContext>(
  value: T & CapableFunction<T>,
  context: T2,
): BoxedFunction<T> => {
  // EventChannel rather than MessageChannel: revived live values arriving in args aren't structured-clonable.
  const { port1: localPort, port2: remotePort } = new EventChannel<CallContext, CallContext>()

  localPort.addEventListener('message', ({ data }) => {
    // Don't recursiveRevive - re-walking would Object.fromEntries plain args, breaking identity.
    const [returnPort, args] = data as CallContext
    ;(async () => {
      let message: ResultMessage
      try {
        const resolved = await value(...(args as Parameters<T>))
        message = { type: 'return', value: resolved as Capable }
      } catch (error) {
        message = { type: 'throw', error: error as Capable }
      }
      // The handler runs detached, so the connection can die while it is still awaiting. Boxing after that
      // builds routing state in a context whose teardown has already run and can never run again: measured,
      // a returned ReadableStream came back LOCKED by box()'s own getReader() and was never cancelled, so
      // whatever fed it was stranded. Nothing can reach the peer now, so release instead of boxing.
      if (isTornDown(context)) {
        if (message.type === 'return') disposeUndelivered(message.value)
        try { returnPort.close() } catch { /* may already be closed */ }
        return
      }
      const boxedResult = (() => {
        try {
          return recursiveBox(message as Capable, context)
        } catch (error) {
          return recursiveBox({ type: 'throw', error: error as Capable } as Capable, context)
        }
      })()
      // No transfer list: the port on this side is always an EventPort (function boxes its channel with
      // EventChannel, so the peer revives a synthetic port), which ignores one. The list that matters is
      // computed on the envelope at the transport boundary, in connections/index.ts.
      postPreBoxed(returnPort, boxedResult as Capable)
      // Defer close so the result reaches the peer before tear-down; without the close portHandlers grows one entry per call.
      queueMicrotask(() => {
        try { returnPort.close() } catch { /* may already be closed */ }
      })
    })()
  })
  localPort.start()

  return {
    ...BoxBase,
    type,
    port: boxMessagePort(remotePort as unknown as MessagePort, context),
  } as unknown as BoxedFunction<T>
}

export const revive = <T extends BoxedFunction, T2 extends RevivableContext>(
  value: T,
  context: T2,
): T[UnderlyingType] => {
  const port = reviveMessagePort(value.port, context) as unknown as MessagePort

  return ((...args: Capable[]) =>
    new Promise((resolve, reject) => {
      // Refuse BEFORE allocating anything. A dead connection can never answer, and the boxing below would
      // strand these args in routing state no teardown will visit again, locking any stream among them.
      // This also keeps `onTeardown`'s immediate-run branch unreachable from inside `settle`'s initializer.
      if (isTornDown(context)) {
        reject(new Error('osra: connection closed'))
        return
      }

      const { port1: returnLocal, port2: returnRemote } = new EventChannel<Capable, Capable>()
      inFlightReturnPorts.add(returnLocal)

      let removeTeardown: (() => void) | undefined
      const settle = () => {
        returnLocal.close()
        inFlightReturnPorts.delete(returnLocal)
        removeTeardown?.()
      }
      // Connection death must reject calls - GC-drop of the proxy intentionally does not (see funcDropDoesNotRejectPending).
      removeTeardown = onTeardown(context, () => {
        reject(new Error('osra: connection closed'))
        settle()
      })

      returnLocal.addEventListener('message', ({ data }) => {
        const message = data as ResultMessage
        if (message.type === 'return') resolve(message.value)
        else reject(message.error)
        settle()
      }, { once: true })
      returnLocal.start()

      // outsideTransfer: user code can call a revived function synchronously from inside a
      // transfer() extent (e.g. a getter evaluated while boxing a transferred chunk); these
      // args are not part of that wrapper's graph
      const callContext = outsideTransfer(() => recursiveBox([returnRemote, args] as unknown as Capable, context))
      postPreBoxed(port, callContext as Capable)
    })) as T[UnderlyingType]
}

const typeCheck = () => {
  const boxed = box((a: number, b: string) => a + b.length, {} as RevivableContext)
  const revived = revive(boxed, {} as RevivableContext)
  const expected: (a: number, b: string) => Promise<number> = revived
  // @ts-expect-error - wrong return type
  const wrongReturn: (a: number, b: string) => Promise<string> = revived
  // @ts-expect-error - wrong parameter types
  const wrongParams: (a: string, b: number) => Promise<number> = revived
  // @ts-expect-error - non-Capable parameter type (WeakMap isn't structured-clonable)
  box((a: WeakMap<object, string>) => a.toString(), {} as RevivableContext)
  // @ts-expect-error - non-Capable return type
  box(() => new WeakMap<object, string>(), {} as RevivableContext)
}
