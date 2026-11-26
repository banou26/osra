import type { BoxBase, RevivableContext } from './utils.js'
import type { DeepReplaceWithBox, DeepReplaceWithRevive } from '../utils/replace.js'
import type { MessageFields, Capable } from '../types.js'

import { OSRA_BOX } from '../types.js'
import { isRevivableBox } from './utils.js'
import { hasQuotedBoxFields, isQuotedBox } from './quote.js'
import { boxMessage, currentWalk } from './walk.js'
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
export { onBoxWalkSettled } from './walk.js'

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
  /** Declare `true` when `isType` never claims a primitive (string, number, boolean, bigint, symbol,
   *  undefined, null). The walker then skips the module for primitive leaves, which is most of what a
   *  large payload is made of. Leaving it off is always safe: the default is to call `isType` for
   *  every value, exactly as before. `objectsOnlyFlagsAreHonest` in the suite calls every flagged
   *  module with a set of primitives and fails if one of them says yes. */
  readonly objectsOnly?: boolean
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

// Revive is fully synchronous, so a module-global set with balanced enter/exit is safe; tracking the *path* (not all visited values) keeps sibling aliasing working.
const revivePath = new WeakSet<object>()

// Marks boxes osra's own modules returned, so they pass through a later walk untouched (boxing a field
// twice stays safe) while any other object shaped like a box is quoted and arrives as it was sent. A
// non-enumerable symbol rather than a WeakSet: structured clone and JSON drop it, and a WeakSet's table
// stayed grown after 100k boxes, failing the 1 MB heap gate (measured 2026-11-26, Chromium 145).
const PRODUCED_BOX: unique symbol = Symbol('osra.producedBox')

const markProduced = (box: object): void => {
  if (Object.isExtensible(box)) Object.defineProperty(box, PRODUCED_BOX, { value: true })
}

const isTrackable = (value: unknown): value is object =>
  value !== null && (typeof value === 'object' || typeof value === 'function')

/** The modules that can claim a primitive, cached per module list. The list is built once per
 *  connection, so this is one filter per connection rather than one per leaf. */
const primitiveModules = new WeakMap<readonly RevivableModule[], readonly RevivableModule[]>()

const modulesForPrimitives = (modules: readonly RevivableModule[]): readonly RevivableModule[] => {
  const cached = primitiveModules.get(modules)
  if (cached) return cached
  const subset = modules.filter(module => !module.objectsOnly)
  primitiveModules.set(modules, subset)
  return subset
}

const quoteBoxObject = <
  TOut,
  TModules extends readonly RevivableModule[]
>(
  value: Record<string, unknown>,
  context: RevivableContext<TModules>,
): TOut => {
  const entries: [string, unknown][] = []
  for (const [k, v] of Object.entries(value)) {
    if (k === OSRA_BOX) continue
    entries.push([k, recursiveBox(v as Capable, context)])
  }
  return {
    [OSRA_BOX]: 'quoted',
    box: value[OSRA_BOX],
    value: Object.fromEntries(entries),
  } as TOut
}

const boxDispatch = <
  T extends Capable,
  TModules extends readonly RevivableModule[]
>(
  value: T,
  context: RevivableContext<TModules>,
  skipType?: string,
): DeepReplaceWithBox<T, TModules[number]> => {
  type ReturnCastType = DeepReplaceWithBox<T, TModules[number]>
  // A primitive leaf cannot be claimed by a module that only handles objects, and a payload is mostly
  // primitive leaves, so those walk a four-entry list instead of the whole one.
  const primitiveLeaf = value === null || (typeof value !== 'object' && typeof value !== 'function')
  const candidates = primitiveLeaf ? modulesForPrimitives(context.revivableModules) : context.revivableModules
  const handledByModule = candidates.find(
    module => module.type !== skipType && module.isType(value)
  )
  if (handledByModule) {
    const boxed = handledByModule.box(value, context)
    if (isRevivableBox(boxed)) markProduced(boxed)
    return boxed as ReturnCastType
  }
  if (hasQuotedBoxFields(value)) {
    return quoteBoxObject<ReturnCastType, TModules>(value as Record<string, unknown>, context)
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
  const walk = currentWalk()
  if (!walk) return boxMessage(value, context) as ReturnCastType
  const revivableBox = isRevivableBox(value)
  if (revivableBox && !walk.quoteAll && Object.hasOwn(value, PRODUCED_BOX)) return value as ReturnCastType
  const quote = revivableBox || isQuotedBox(value)
  const track = isTrackable(value)
  if (track) {
    if (walk.path.has(value)) {
      throw new TypeError('osra: cannot serialize a circular structure - break the cycle or send the container by reference')
    }
    walk.path.add(value)
  }
  try {
    return quote
      ? quoteBoxObject<ReturnCastType, TModules>(value as Record<string, unknown>, context)
      : boxDispatch(value, context)
  } finally {
    if (track) walk.path.delete(value)
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
    if (isQuotedBox(value)) {
      const inner = descend<Record<string, unknown>>(value.value, v => recursiveRevive(v, context))
      return { ...inner, [OSRA_BOX]: value.box } as ReturnCastType
    }
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