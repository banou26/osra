import type { BoxBase, RevivableContext } from './utils.js'
import type { DeepReplaceWithBox, DeepReplaceWithRevive } from '../utils/replace.js'
import type { MessageFields, Capable } from '../types.js'

import { isRevivableBox } from './utils.js'
import * as arrayBuffer from './array-buffer.js'
import * as date from './date.js'
import * as headers from './headers.js'
import * as error from './error.js'
import * as typedArray from './typed-array.js'
import * as promise from './promise.js'
import * as func from './function.js'
import * as messagePort from './message-port.js'
import * as readableStream from './readable-stream.js'
import * as writableStream from './writable-stream.js'
import * as abortSignal from './abort-signal.js'
import * as response from './response.js'
import * as request from './request.js'
import * as identity from './identity.js'
import * as transfer from './transfer.js'
import * as map from './map.js'
import * as set from './set.js'
import * as bigInt from './bigint.js'
import * as event from './event.js'
import * as eventTarget from './event-target.js'
import * as symbol from './symbol.js'
import * as asyncIterator from './async-iterator.js'
import { blob, clonable, transferable, unclonable } from './fallbacks.js'
import { nonFiniteNumber, undefinedValue } from './json-primitives.js'

export { identity } from './identity.js'
export { transfer } from './transfer.js'

export * from './utils.js'

// `any` on box/revive/init: the bivariance escape hatch that lets modules assign.
export type RevivableModule<
  T extends string = string,
  T2 = any,
  T3 extends BoxBase<T> = any,
  T4 extends MessageFields = MessageFields,
> = {
  readonly type: T
  readonly isType: (value: unknown) => value is T2
  readonly box: ((value: T2, context: RevivableContext<any>) => T3) | ((...args: any[]) => any)
  readonly revive: (value: T3, context: RevivableContext<any>) => T2
  readonly init?: (context: RevivableContext<any>) => void
  readonly Messages?: T4
}

export const defaultRevivableModules = [
  transfer,
  identity,
  arrayBuffer,
  date,
  headers,
  error,
  typedArray,
  promise,
  func,
  messagePort,
  readableStream,
  writableStream,
  abortSignal,
  response,
  request,
  map,
  set,
  bigInt,
  symbol,
  event,
  // After readableStream, before the fallbacks so generators don't coerce to {}.
  asyncIterator,
  nonFiniteNumber,
  undefinedValue,
  // clonable/transferable before eventTarget: OffscreenCanvas & co. also extend EventTarget.
  clonable,
  transferable,
  // After clonable (File rides it): bare Blobs would otherwise silently coerce to `{}` on JSON.
  blob,
  // eventTarget MUST be last among instanceof-EventTarget revivables - the specific ones need first dibs.
  eventTarget,
  unclonable,
] as const

export type DefaultRevivableModules = typeof defaultRevivableModules
export type DefaultRevivableModule = DefaultRevivableModules[number]

const findReviveModule = (
  value: BoxBase,
  modules: readonly RevivableModule[],
): RevivableModule | undefined =>
  modules.find(module => module.type === value.type)

const isPlainObject = (value: unknown): value is Record<string, Capable> =>
  !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype

const descend = <TOut>(value: unknown, transform: (v: Capable) => unknown): TOut => {
  if (Array.isArray(value)) {
    return value.map(v => transform(v)) as TOut
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries<Capable>(value).map(([k, v]) => [k, transform(v)]),
    ) as TOut
  }
  return value as TOut
}

// Box/revive are fully synchronous, so a module-global set with balanced enter/exit is safe; tracking the *path* (not all visited values) keeps sibling aliasing working.
const boxPath = new WeakSet<object>()
const revivePath = new WeakSet<object>()

const isTrackable = (value: unknown): value is object =>
  value !== null && (typeof value === 'object' || typeof value === 'function')

const boxDispatch = <
  T extends Capable,
  TModules extends readonly RevivableModule[]
>(
  value: T,
  context: RevivableContext<TModules>,
  skipType?: string,
): DeepReplaceWithBox<T, TModules[number]> => {
  type ReturnCastType = DeepReplaceWithBox<T, TModules[number]>
  const handledByModule = context.revivableModules.find(
    module => module.type !== skipType && module.isType(value)
  )
  if (handledByModule) {
    return handledByModule.box(value, context) as ReturnCastType
  }
  return descend<ReturnCastType>(value, v => recursiveBox(v, context))
}

export const recursiveBox = <
  T extends Capable,
  TModules extends readonly RevivableModule[]
>(
  value: T,
  context: RevivableContext<TModules>
): DeepReplaceWithBox<T, TModules[number]> => {
  type ReturnCastType = DeepReplaceWithBox<T, TModules[number]>
  if (isRevivableBox(value)) return value as ReturnCastType
  const track = isTrackable(value)
  if (track) {
    if (boxPath.has(value)) {
      throw new TypeError('osra: cannot serialize a circular structure - break the cycle or send the container by reference')
    }
    boxPath.add(value)
  }
  try {
    return boxDispatch(value, context)
  } finally {
    if (track) boxPath.delete(value)
  }
}

/** Box a value your own module claimed in place: every other module gets its turn and children are
 *  walked as usual, but `claimedBy` is skipped, and the cycle guard the caller's `recursiveBox`
 *  frame already holds for this value is not re-entered.
 *  A module needs this when its `isType` matches a bare value rather than a wrapper around one, the
 *  way `identity()` marks a reference in place: `recursiveBox` on that same value would come
 *  straight back to the module, and the guard would report it as a cycle. */
export const boxClaimedValue = <
  T extends Capable,
  TModules extends readonly RevivableModule[]
>(
  value: T,
  context: RevivableContext<TModules>,
  claimedBy: string,
): DeepReplaceWithBox<T, TModules[number]> =>
  boxDispatch(value, context, claimedBy)

export const recursiveRevive = <
  T extends Capable,
  TModules extends readonly RevivableModule[]
>(
  value: T,
  context: RevivableContext<TModules>
): DeepReplaceWithRevive<T, TModules[number]> => {
  type ReturnCastType = DeepReplaceWithRevive<T, TModules[number]>
  const track = isTrackable(value)
  if (track) {
    if (revivePath.has(value)) {
      throw new TypeError('osra: cannot revive a circular structure')
    }
    revivePath.add(value)
  }
  try {
    if (isRevivableBox(value)) {
      const handledByModule = findReviveModule(value, context.revivableModules)
      if (handledByModule) {
        return handledByModule.revive(value, context) as ReturnCastType
      }
    }
    return descend<ReturnCastType>(value, v => recursiveRevive(v, context))
  } finally {
    if (track) revivePath.delete(value)
  }
}