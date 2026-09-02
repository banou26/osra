import type { Capable } from '../types.js'
import type { BoxBase as BoxBaseType, RevivableContext, UnderlyingType } from './utils.js'

import { BoxBase } from './utils.js'
import { instanceOfAny, isJsonOnlyTransport } from '../utils/type-guards.js'
import { recursiveBox, recursiveRevive } from './index.js'

export const type = 'transfer' as const

/** Never claims a primitive, so the walker can skip this module for primitive leaves. */
export const objectsOnly = true

const TRANSFER_MARKER: unique symbol = Symbol.for('osra.transfer')

type TransferWrapper<T = unknown> = {
  readonly [TRANSFER_MARKER]: true
  readonly value: T
}

export type BoxedTransfer<T extends Capable = Capable> = BoxBaseType<typeof type> & {
  inner: Capable
  degraded: boolean
  [UnderlyingType]: T
}

const isObject = (value: unknown): value is object =>
  value !== null && typeof value === 'object'

const isTransferWrapper = (value: unknown): value is TransferWrapper =>
  isObject(value) && TRANSFER_MARKER in value && value[TRANSFER_MARKER] === true

const isWrappableTransferable = (value: unknown): boolean => {
  if (!isObject(value)) return false
  if (ArrayBuffer.isView(value)) return true
  return instanceOfAny(value, [
    globalThis.ArrayBuffer,
    globalThis.MessagePort,
    globalThis.ReadableStream,
    globalThis.WritableStream,
    globalThis.TransformStream,
    // Request/Response are not platform Transferables, but wrapping them puts their
    // body stream inside the transfer extent so its chunks inherit move semantics
    globalThis.Request,
    globalThis.Response,
    globalThis.ImageBitmap,
    globalThis.OffscreenCanvas,
    (globalThis as { VideoFrame?: abstract new (...args: any[]) => unknown }).VideoFrame,
    (globalThis as { AudioData?: abstract new (...args: any[]) => unknown }).AudioData,
  ])
}

/** Opt into transfer (move) semantics for a transferable value. Idempotent;
 *  non-transferable inputs pass through unchanged. Silently degrades to a
 *  copy when the platform/transport can't transfer the given type. Lies at
 *  the type level - runtime value is a TransferWrapper<T> typed as T. */
export const transfer = <T>(value: T): T =>
  (isWrappableTransferable(value)
    ? { [TRANSFER_MARKER]: true, value }
    : value
  ) as T

// Boxing is fully synchronous (same invariant boxPath in index.ts relies on), so a
// balanced enter/exit counter is enough to tell "currently inside a transfer() wrapper".
let transferDepth = 0

/** Whether boxing is happening inside a transfer() wrapper's extent. Streams read
 *  this at box time so transfer(stream) propagates move semantics to their chunks. */
export const isInTransfer = () => transferDepth > 0

/** Internal chunk marker: unlike the public transfer(), wraps containers too, so
 *  transferables nested anywhere inside a chunk move. Not part of the public API. */
export const forceTransfer = <T>(value: T): T =>
  (isObject(value) && !isTransferWrapper(value)
    ? { [TRANSFER_MARKER]: true, value }
    : value
  ) as T

/** Runs fn with the ambient transfer extent suspended. Boxing at independent walk
 *  entry points (protocol ports, revived-function calls) can fire synchronously
 *  inside someone else's transfer() extent - an EventPort.start() flush during
 *  boxing, or user code (a getter) calling a revived function mid-walk. Those
 *  values are not part of the wrapper's graph, so their move semantics must come
 *  from a wrapper in their own data, never from the ambient counter. */
export const outsideTransfer = <T>(fn: () => T): T => {
  const saved = transferDepth
  transferDepth = 0
  try {
    return fn()
  } finally {
    transferDepth = saved
  }
}

export const isType = (value: unknown): value is TransferWrapper =>
  isTransferWrapper(value)

export const box = <T extends Capable, TContext extends RevivableContext>(
  wrapper: TransferWrapper<T>,
  context: TContext,
): BoxedTransfer<T> => {
  transferDepth++
  try {
    // `degraded` tells the send-time walker in getTransferableObjects to skip the transfer-list entry
    return {
      ...BoxBase,
      type,
      inner: recursiveBox(wrapper.value, context),
      degraded: isJsonOnlyTransport(context.transport),
    } as unknown as BoxedTransfer<T>
  } finally {
    transferDepth--
  }
}

export const revive = <T extends BoxedTransfer, TContext extends RevivableContext>(
  value: T,
  context: TContext,
): T[UnderlyingType] =>
  recursiveRevive(value.inner, context) as T[UnderlyingType]

const typeCheck = () => {
  const ab = new ArrayBuffer(10)
  const wrapper = { [TRANSFER_MARKER]: true, value: ab } as TransferWrapper<ArrayBuffer>
  const boxed = box(wrapper, {} as RevivableContext)
  const revived = revive(boxed, {} as RevivableContext)
  const expected: ArrayBuffer = revived
  // @ts-expect-error - revived is ArrayBuffer, not string
  const notExpected: string = revived
  // @ts-expect-error - cannot box a non-Capable wrapper (WeakMap not assignable)
  box({ [TRANSFER_MARKER]: true, value: new WeakMap() } as TransferWrapper<WeakMap<object, string>>, {} as RevivableContext)
}
