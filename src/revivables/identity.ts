import type { Capable, Uuid } from '../types.js'
import type { RevivableContext, BoxBase as BoxBaseType } from './utils.js'
import type { UnderlyingType } from '../utils/type.js'

import { BoxBase } from './utils.js'
import { boxClaimedValue, recursiveRevive } from './index.js'
import { isTornDown, onTeardown } from '../utils/teardown.js'

export const type = 'identity' as const

export type Messages = {
  type: 'identity-dispose'
  remoteUuid: Uuid
  id: string
}

export declare const Messages: Messages

const IDENTITY_MARKER: unique symbol = Symbol.for('osra.identity')

/** Phantom shape. A tracked value carries no marker of its own, the mark lives in a WeakMap, so
 *  this is what `isType` declares instead: matching it at the type level would widen `Capable` to
 *  every object, and nothing a user writes structurally matches this. */
type IdentityMarked = { readonly [IDENTITY_MARKER]: true }

export type BoxedIdentity<T extends Capable = Capable> = BoxBaseType<typeof type> & {
  id: string
  inner?: Capable
  [UnderlyingType]: T
}

const isObjectOrFunction = (value: unknown): value is object =>
  value !== null && (typeof value === 'object' || typeof value === 'function')

/** Anything we can hand to WeakMap/WeakRef/FinalizationRegistry. Excludes
 *  registered symbols (Symbol.for) - those throw at runtime. */
const isWeakKeyable = (value: unknown): value is WeakKey => {
  if (value === null) return false
  const t = typeof value
  if (t === 'object' || t === 'function') return true
  if (t === 'symbol') return Symbol.keyFor(value as symbol) === undefined
  return false
}

/** Reference to id, for the whole realm rather than one connection. The id is minted once, wherever
 *  the reference first became an identity - `identity()` here, or reviving one from a peer - and
 *  from then on it travels with the value onto every connection it is sent over. That is what makes
 *  a value keep its identity down a chain of contexts: each hop hands the same id to the next, so
 *  the value coming back resolves to what that hop handed out, all the way to the origin. */
const valueToId = new WeakMap<WeakKey, string>()

const idFor = (value: WeakKey): string => {
  const existing = valueToId.get(value)
  if (existing !== undefined) return existing
  const id = globalThis.crypto.randomUUID()
  valueToId.set(value, id)
  return id
}

/** Mark a value so osra preserves its reference identity across the boundary. The peer's revived
 *  value stands for this one, and handing it back - to you, or onward to a further context and back
 *  again - resolves to this very reference. The mark sticks to the value, so only the side that
 *  owns it has to opt in. Idempotent, and primitives pass through unchanged. */
export const identity = <T>(value: T): T => {
  if (isObjectOrFunction(value)) idFor(value)
  return value
}

type IdentityState = {
  /** Every id that has crossed this connection, either way, mapped to what it denotes on this side.
   *  `has` doubles as "the peer can resolve this id", which is what lets a resend skip the payload.
   *  Weak, because an entry outliving its value would resolve to nothing anyway. */
  readonly idToLocal: Map<string, WeakRef<WeakKey>>
  /** Values revived from this peer, held until the peer says its own reference is gone: it can send
   *  the bare id at any time and expects this exact value back. */
  readonly pins: Map<string, unknown>
  readonly disposeRegistry: FinalizationRegistry<string>
}

const connectionStates = new WeakMap<RevivableContext, IdentityState>()

const getOrCreateState = (context: RevivableContext): IdentityState => {
  const existing = connectionStates.get(context)
  if (existing) return existing
  const idToLocal = new Map<string, WeakRef<WeakKey>>()
  const pins = new Map<string, unknown>()
  const disposeRegistry = new FinalizationRegistry<string>((id) => {
    idToLocal.delete(id)
    if (isTornDown(context)) return
    try {
      context.sendMessage({ type: 'identity-dispose', remoteUuid: context.remoteUuid, id })
    } catch { /* connection already closed */ }
  })
  const state: IdentityState = { idToLocal, pins, disposeRegistry }
  connectionStates.set(context, state)
  context.eventTarget.addEventListener('message', ({ detail }) => {
    if (detail?.type !== 'identity-dispose') return
    state.pins.delete(detail.id)
    // Dropped too, not just unpinned: the peer's reference is gone, so a later send of our own value
    // has to carry the payload again instead of a bare id nothing over there could resolve.
    state.idToLocal.delete(detail.id)
  })
  onTeardown(context, () => {
    state.pins.clear()
    state.idToLocal.clear()
  })
  return state
}

export const isType = (value: unknown): value is IdentityMarked =>
  isObjectOrFunction(value) && valueToId.has(value)

/** The shared tail of both box paths: hand the peer the id alone when it can already resolve it,
 *  and otherwise the id plus the payload, remembering that this peer now knows it. */
const boxTracked = (
  value: WeakKey,
  buildInner: () => Capable,
  state: IdentityState,
): BoxedIdentity => {
  const id = idFor(value)
  if (state.idToLocal.has(id)) return { ...BoxBase, type, id } as BoxedIdentity
  // Before recording the id, so a value containing itself still hits the cycle guard rather than
  // shipping a self-reference the peer could never revive.
  const inner = buildInner()
  state.idToLocal.set(id, new WeakRef(value))
  // The peer holds its revived value until we tell it this one is gone.
  state.disposeRegistry.register(value, id)
  return { ...BoxBase, type, id, inner } as BoxedIdentity
}

export const box = <T extends Capable, TContext extends RevivableContext>(
  value: T,
  context: TContext,
): BoxedIdentity<T> => {
  const state = getOrCreateState(context)
  const buildInner = () => boxClaimedValue(value, context, type) as Capable
  if (!isWeakKeyable(value)) {
    return { ...BoxBase, type, id: globalThis.crypto.randomUUID(), inner: buildInner() } as BoxedIdentity<T>
  }
  return boxTracked(value, buildInner, state) as BoxedIdentity<T>
}

/** Identity-box a referenceable value with a caller-supplied inner box, bypassing the walker. Used
 *  by revivables (symbol with description=undefined) where recursing back through their own box
 *  would loop into this module again. */
export const boxByReference = <T extends WeakKey, TContext extends RevivableContext>(
  value: T,
  innerBox: Capable,
  context: TContext,
): BoxedIdentity =>
  boxTracked(value, () => innerBox, getOrCreateState(context))

export const revive = <T extends BoxedIdentity, TContext extends RevivableContext>(
  value: T,
  context: TContext,
): T[UnderlyingType] => {
  const state = getOrCreateState(context)
  if (state.pins.has(value.id)) return state.pins.get(value.id) as T[UnderlyingType]
  const known = state.idToLocal.get(value.id)?.deref()
  if (known !== undefined) return known as T[UnderlyingType]
  if (!('inner' in value) || value.inner === undefined) {
    throw new Error(`osra identity: received id=${value.id} with no inner payload and nothing local to resolve it to`)
  }
  const revived = recursiveRevive(value.inner, context)
  state.pins.set(value.id, revived)
  if (isWeakKeyable(revived)) {
    // Carries the id onward: sending this value to a further context sends it under the same id, so
    // whatever comes back through the chain lands on this very value again.
    if (!valueToId.has(revived)) valueToId.set(revived, value.id)
    state.idToLocal.set(value.id, new WeakRef(revived))
  }
  return revived as T[UnderlyingType]
}

const typeCheck = () => {
  const fn = () => 42
  const boxed = box(fn, {} as RevivableContext)
  const revived = revive(boxed, {} as RevivableContext)
  const expected: typeof fn = revived
  // @ts-expect-error - revived is the original function type, not string
  const notExpected: string = revived
  // @ts-expect-error - cannot box a non-Capable value (WeakMap not assignable)
  box(new WeakMap<object, string>(), {} as RevivableContext)
  const marked: typeof fn = identity(fn)
}
