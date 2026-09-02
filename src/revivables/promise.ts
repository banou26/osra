import type { Capable } from '../types.js'
import type { RevivableContext, BoxBase as BoxBaseType } from './utils.js'
import type { UnderlyingType } from './index.js'
import type {
  BadFieldValue, BadFieldPath, BadFieldParent,
  ErrorMessage, BadValue, Path, ParentObject
} from '../utils/capable-check.js'

import { BoxBase } from './utils.js'
import { isTornDown, onTeardown } from '../utils/teardown.js'
import {
  createRevivableChannel,
  revive as reviveMessagePort,
  BoxedMessagePort,
  AnyPort,
} from './message-port.js'

export const type = 'promise' as const

/** Never claims a primitive, so the walker can skip this module for primitive leaves. */
export const objectsOnly = true

export type Context =
  | { type: 'resolve', data: Capable }
  | { type: 'reject', error: Capable }

// error branches intersect with T so the excess-property check flags the failure, not a user key
type CapablePromise<T> = T extends Promise<infer U>
  ? U extends Capable
    ? T
    : T & {
        [ErrorMessage]: 'Value type must extend a Promise that resolves to a Capable'
        [BadValue]: BadFieldValue<U, Capable>
        [Path]: BadFieldPath<U, Capable>
        [ParentObject]: BadFieldParent<U, Capable>
      }
  : T & {
      [ErrorMessage]: 'Value type must extend a Promise that resolves to a Capable'
      [BadValue]: T
      [Path]: ''
      [ParentObject]: T
    }

type ExtractCapable<T> = T extends Promise<infer U>
  ? U extends Capable ? U : never
  : never

const isCapablePromise = <T, U extends Capable = ExtractCapable<T>>(value: T): value is T & Promise<U> =>
  value instanceof Promise

export type BoxedPromise<T extends Capable = Capable> =
  & BoxBaseType<typeof type>
  & { port: BoxedMessagePort<Context> }
  & { [UnderlyingType]: T }

// pins the revived port until settle: the port↔listener cycle has no other anchor
const inFlightPromisePorts = new Set<AnyPort<Context>>()

export const isType = (value: unknown): value is Promise<any> =>
  value instanceof Promise

export const box = <T, T2 extends RevivableContext>(
  value: CapablePromise<T>,
  context: T2
): BoxedPromise<ExtractCapable<T>> => {
  if (!isCapablePromise(value)) throw new TypeError('Expected Promise')
  const { localPort, boxedRemote } = createRevivableChannel<Context>(context)

  const sendResult = (result: Context) => {
    localPort.postMessage(result)
    localPort.close()
  }

  value
    .then((data: ExtractCapable<T>) => sendResult({ type: 'resolve', data }))
    .catch((error: unknown) => sendResult({ type: 'reject', error: error as Capable }))

  return { ...BoxBase, type, port: boxedRemote } as BoxedPromise<ExtractCapable<T>>
}

export const revive = <T extends BoxedPromise, T2 extends RevivableContext>(
  value: T,
  context: T2
) => {
  const port = reviveMessagePort(value.port, context)
  inFlightPromisePorts.add(port)
  // transferred MessagePorts keep working past protocol teardown, so those must stay pending rather than reject
  const wireRouted = 'portId' in value.port
  return new Promise<T[UnderlyingType]>((resolve, reject) => {
    let removeTeardown: (() => void) | undefined
    const settle = () => {
      port.close()
      inFlightPromisePorts.delete(port)
      removeTeardown?.()
    }
    // Same refuse-before-registering rule as function.revive: onTeardown runs its callback immediately on a
    // dead scope, which would otherwise reach `removeTeardown` from inside its own initializer
    if (wireRouted && isTornDown(context)) {
      reject(new Error('osra: connection closed'))
      settle()
      return
    }
    removeTeardown = !wireRouted ? undefined : onTeardown(context, () => {
      reject(new Error('osra: connection closed'))
      settle()
    })
    port.addEventListener('message', ({ data: result }) => {
      if (result.type === 'resolve') resolve(result.data as T[UnderlyingType])
      else reject(result.error)
      settle()
    }, { once: true })
    port.start()
  })
}

const typeCheck = () => {
  const boxed = box(Promise.resolve(1 as const), {} as RevivableContext)
  const revived = revive(boxed, {} as RevivableContext)
  const expected: Promise<1> = revived
  // @ts-expect-error
  const notExpected: Promise<string> = revived
  // @ts-expect-error
  box(1 as const, {} as RevivableContext)
}
