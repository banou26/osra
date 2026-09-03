import type { Capable, StructurableTransferable, Uuid } from '../types.js'
import type { TypedMessageChannel, TypedMessagePort } from '../utils/typed-message-channel.js'
import type { RevivableContext, BoxBase as BoxBaseType } from './utils.js'
import type { UnderlyingType } from '../utils/type.js'
import type {
  BadFieldValue, BadFieldPath, BadFieldParent,
  ErrorMessage, BadValue, Path, ParentObject
} from '../utils/capable-check.js'

import { BoxBase } from './utils.js'
import { outsideTransfer } from './transfer.js'
import { recursiveBox, recursiveRevive } from './index.js'
import { getTransferableObjects } from '../utils/transferable.js'
import { isJsonOnlyTransport } from '../utils/type-guards.js'
import { EventChannel, EventPort } from '../utils/event-channel.js'
import { trackGc } from '../utils/gc-tracker.js'
import { onTeardown } from '../utils/teardown.js'

export const type = 'messagePort' as const

/** Never claims a primitive, so the walker can skip this module for primitive leaves. */
export const objectsOnly = true

export type Messages =
  | { type: 'message', remoteUuid: Uuid, data: Capable, portId: Uuid, seq?: number }
  | { type: 'message-port-close', remoteUuid: Uuid, portId: Uuid, seq?: number }

export declare const Messages: Messages

export type AnyPort<T = Capable> =
  | TypedMessagePort<T>
  | EventPort<T>

export type BoxedMessagePort<T = Capable> =
  & BoxBaseType<typeof type>
  & (
    | { portId: Uuid, synthetic: true }
    | { portId: Uuid, synthetic: false }
    | { port: AnyPort<T>, autoBox?: boolean }
  )
  & { [UnderlyingType]: TypedMessagePort<T> }

// `[T] extends [Capable]` disables distributive conditionals so `A | B` gives back `AnyPort<A | B>`, not `AnyPort<A> | AnyPort<B>`
type StructurableTransferablePort<T> = [T] extends [Capable]
  ? AnyPort<T>
  : AnyPort<T> & {
      [ErrorMessage]: 'Message type must extend Capable'
      [BadValue]: BadFieldValue<T, Capable>
      [Path]: BadFieldPath<T, Capable>
      [ParentObject]: BadFieldParent<T, Capable>
    }

// wire contract: each side stamps its outgoing port messages with a monotonic `seq`, and the receiver buffers by seq and delivers strictly in send-order once a handler exists
// the credit-window readable-stream protocol relies on that in-order delivery; port messages can also arrive BEFORE the message that revives the port and registers its handler, which is why handler-less routing entries exist at all
type PortRouting = {
  handler?: (message: Messages) => void
  /** Next incoming seq to deliver. */
  nextSeq: number
  /** Out-of-order / early incoming messages, keyed by their seq. */
  buffer: Map<number, Messages>
  /** Next outgoing seq to stamp on this side's messages for the port. */
  outSeq: number
}

// caps the per-port reorder buffer so a peer that never sends the awaited seq can't grow it without bound - overflow fails the port closed instead of wedging it silently
const REORDER_LIMIT = 2048
// remembers closed portIds so late in-flight messages can't resurrect routing state
const TOMBSTONE_LIMIT = 128
// caps routing entries allocated by messages arriving before their port's handler registers
const PENDING_PORT_LIMIT = 1024

type ConnectionMessagePortState = {
  /** O(1) per-portId routing - avoids the O(N) addEventListener scan that was the
   *  bottleneck for tight-loop RPC traffic. */
  ports: Map<string, PortRouting>
  /** Recently closed portIds, insertion-ordered for bounded eviction. */
  tombstones: Set<string>
  /** Count of handler-less entries in `ports`. */
  pendingPorts: number
}

const connectionStateMap = new WeakMap<RevivableContext, ConnectionMessagePortState>()

const getState = (context: RevivableContext): ConnectionMessagePortState => {
  const state = connectionStateMap.get(context)
  if (!state) throw new Error('osra message-port: connection state missing; did init() run?')
  return state
}

const getPort = (state: ConnectionMessagePortState, portId: string): PortRouting => {
  let port = state.ports.get(portId)
  if (!port) {
    port = { nextSeq: 0, buffer: new Map(), outSeq: 0 }
    state.ports.set(portId, port)
    state.pendingPorts++
  }
  return port
}

const tombstonePort = (state: ConnectionMessagePortState, portId: string): void => {
  const port = state.ports.get(portId)
  if (port && !port.handler) state.pendingPorts--
  state.ports.delete(portId)
  if (state.tombstones.size >= TOMBSTONE_LIMIT) {
    const oldest = state.tombstones.values().next().value
    if (oldest !== undefined) state.tombstones.delete(oldest)
  }
  state.tombstones.add(portId)
}

const drainPort = (port: PortRouting): void => {
  if (!port.handler) return
  for (let next = port.buffer.get(port.nextSeq); next !== undefined; next = port.buffer.get(port.nextSeq)) {
    port.buffer.delete(port.nextSeq)
    port.nextSeq++
    port.handler(next)
  }
}

const nextOutSeq = (context: RevivableContext, portId: Uuid): number => getPort(getState(context), portId).outSeq++

const registerPortHandler = (
  context: RevivableContext,
  portId: Uuid,
  handler: (message: Messages) => void,
): void => {
  const state = getState(context)
  if (state.tombstones.has(portId)) {
    // macrotask, not microtask: revived ports reach their consumer through microtask chains, which must win so close listeners attach first
    setTimeout(() => handler({ type: 'message-port-close', remoteUuid: context.remoteUuid, portId }))
    return
  }
  const port = getPort(state, portId)
  if (!port.handler) state.pendingPorts--
  port.handler = handler
  drainPort(port)
}

export const init = (context: RevivableContext): void => {
  const state: ConnectionMessagePortState = { ports: new Map(), tombstones: new Set(), pendingPorts: 0 }
  connectionStateMap.set(context, state)

  context.eventTarget.addEventListener('message', ({ detail }) => {
    if (detail.type !== 'message' && detail.type !== 'message-port-close') return
    if (state.tombstones.has(detail.portId)) return
    let port = state.ports.get(detail.portId)
    // a legacy peer (osra <= 0.5.6) does not stamp seq, so deliver in arrival order
    if (detail.seq === undefined) { port?.handler?.(detail); return }
    if (!port) {
      if (state.pendingPorts >= PENDING_PORT_LIMIT) return
      port = getPort(state, detail.portId)
    }
    if (detail.seq < port.nextSeq) return
    if (port.buffer.size >= REORDER_LIMIT && !(detail.seq === port.nextSeq && port.handler)) {
      port.buffer.clear()
      tombstonePort(state, detail.portId)
      port.handler?.({ type: 'message-port-close', remoteUuid: context.remoteUuid, portId: detail.portId })
      return
    }
    port.buffer.set(detail.seq, detail)
    drainPort(port)
  })

  onTeardown(context, () => {
    for (const [portId, port] of [...state.ports]) {
      port.handler?.({ type: 'message-port-close', remoteUuid: context.remoteUuid, portId: portId as Uuid })
    }
    state.ports.clear()
    state.tombstones.clear()
    state.pendingPorts = 0
  })
}

export const isType = (value: unknown): value is MessagePort | EventPort<StructurableTransferable> =>
  value instanceof MessagePort || value instanceof EventPort

const sendClose = (context: RevivableContext, portId: Uuid) => {
  try {
    // the close MUST carry the next seq so it stays ordered after this side's data messages, which it would otherwise drop
    // a missing routing entry means the port is already torn down, so `seq: port ? port.outSeq++ : 0` reads it without resurrecting routing state (do not switch to getPort here)
    const port = getState(context).ports.get(portId)
    context.sendMessage({ type: 'message-port-close', remoteUuid: context.remoteUuid, portId, seq: port ? port.outSeq++ : 0 })
  } catch {}
}

const postRevived = <T>(port: AnyPort<T>, data: T, synthetic: boolean) => {
  if (synthetic) { port.postMessage(data); return }
  const transferables = getTransferableObjects(data)
  port.postMessage(data, transferables)
  markPortsShipped(transferables)
}

/** Revives an inbound port message and hands it to `deliver`, or drops it and calls `onError`.
 *  A revive failure used to leave the port listener as a throw. A browser reports a throw from a
 *  listener to the page and moves on, where node re-raises it as an uncaughtException that ends the
 *  process, so the same protocol event was a console line on one host and fatal on the other.
 *  `identity` throws on purpose once it has asked the sender to drop its record, so dropping the one
 *  message is all that is left to do here; the connection and the other buffered port messages carry
 *  on. The host still gets the report where it offers a non-fatal channel for one (`reportError`),
 *  which keeps a browser console reading as it did. */
const reviveInbound = <T>(
  data: Capable,
  context: RevivableContext,
  deliver: (revived: T) => void,
  onError: () => void,
): void => {
  let revived: T
  try {
    revived = recursiveRevive(data, context) as T
  } catch (error) {
    onError()
    globalThis.reportError?.(error)
    return
  }
  deliver(revived)
}

// MUST stay in its own scope: sharing box()'s environment record would let the FR-held closure pin context/liveRef/handlers, breaking the gc-tracker contract
const makeBoxGcNet = (
  contextWeak: WeakRef<RevivableContext>,
  stateWeak: WeakRef<ConnectionMessagePortState>,
  portId: Uuid,
) => () => {
  const ctx = contextWeak.deref()
  if (ctx) sendClose(ctx, portId)
  const state = stateWeak.deref()
  if (state) tombstonePort(state, portId)
}

/** Payloads that are already boxed, so the port listener forwards them as they are.
 *
 *  `function` has to box eagerly (the args must be snapshotted in the caller's synchronous frame,
 *  before user code can mutate them), and the port would otherwise walk the very same value again:
 *  boxes short-circuit, but every plain container in between is rebuilt and every leaf re-dispatched
 *  through the whole module list, in both directions. `EventPort.postMessage` hands the peer the same
 *  object reference, which is what makes the mark findable on the other side. */
const preBoxedPayloads = new WeakSet<object>()

const isMarkable = (value: unknown): value is object =>
  value !== null && (typeof value === 'object' || typeof value === 'function')

/** Post a payload that is already boxed. Anything else must go through `postMessage` as usual. */
export const postPreBoxed = (
  port: MessagePort,
  boxed: Capable,
  transferables?: Transferable[],
): void => {
  if (isMarkable(boxed)) preBoxedPayloads.add(boxed)
  port.postMessage(boxed, transferables ?? [])
}

/** Consumes the mark: a value posted twice is boxed the second time, as it must be. */
const boxUnlessPreBoxed = <TContext extends RevivableContext>(data: Capable, context: TContext): Capable =>
  isMarkable(data) && preBoxedPayloads.delete(data)
    ? data
    // outsideTransfer: liveRef.start() can flush queued messages synchronously while a transfer()
    // extent is on the stack - queued values are not part of it
    : outsideTransfer(() => recursiveBox(data, context)) as Capable

export const box = <T, T2 extends RevivableContext = RevivableContext>(
  value: StructurableTransferablePort<T>,
  context: T2,
  options?: { autoBox?: boolean },
): BoxedMessagePort<T> => {
  // synthetic EventPorts are not structured-clonable, so even a clone transport routes them via portId
  const synthetic = value instanceof EventPort
  if (!synthetic && !isJsonOnlyTransport(context.transport)) {
    return {
      ...BoxBase, type, port: value,
      ...(options?.autoBox ? { autoBox: true } : {}),
    } as BoxedMessagePort<T>
  }

  const state = getState(context)
  const liveRef: AnyPort<T> = value
  const portId: Uuid = globalThis.crypto.randomUUID()

  const liveRefWeak = new WeakRef(liveRef)
  const contextWeak = new WeakRef(context)
  const stateWeak = new WeakRef(state)

  let cleanedUp = false
  const performCleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    const st = stateWeak.deref()
    if (st) tombstonePort(st, portId)
    unregisterGc?.()
    const live = liveRefWeak.deref()
    live?.removeEventListener('message', outgoingListener as EventListener)
    if (live instanceof EventPort) live._onClose = undefined
  }

  const handler = (message: Messages) => {
    if (message.type === 'message-port-close') {
      performCleanup()
      liveRef.dispatchEvent(new Event('close'))
      liveRef.close()
      return
    }
    // the message would have landed on the end the user holds, which a real MessagePort cannot reach from here
    reviveInbound<T>(message.data, context, revived => postRevived(liveRef, revived, false), () => {})
  }

  function outgoingListener({ data }: MessageEvent<Capable>) {
    context.sendMessage({
      type: 'message',
      remoteUuid: context.remoteUuid,
      data: boxUnlessPreBoxed(data, context),
      portId,
      seq: nextOutSeq(context, portId),
    })
  }

  const unregisterGc = trackGc(liveRef, makeBoxGcNet(contextWeak, stateWeak, portId))

  liveRef.addEventListener('message', outgoingListener as EventListener)
  liveRef.start()

  if (liveRef instanceof EventPort) {
    liveRef._onClose = () => {
      if (cleanedUp) return
      sendClose(context, portId)
      performCleanup()
    }
  }

  registerPortHandler(context, portId, handler)

  return { ...BoxBase, type, portId, synthetic } as BoxedMessagePort<T>
}

export const revive = <T extends Capable, T2 extends RevivableContext>(
  value: BoxedMessagePort<T>,
  context: T2,
): TypedMessagePort<T> => {
  if ('port' in value) {
    // Revived in the realm that made it, so it never travelled: release what its local end held
    markPortsShipped([value.port as MessagePort])
    if (value.autoBox) return createProtocolPort<T>(value.port as TypedMessagePort<Capable>, context)
    return value.port
  }
  return reviveViaPortId<T>(value.portId, context, value.synthetic)
}

/** Wraps a real MessagePort so revivables can treat it like a transparent
 *  EventTarget that auto-boxes/revives - letting live values (Promises,
 *  Functions, …) ride a clone-only transport. */
/** Whether the peer of a channel's local end has left this realm yet, and what the local end did
 *  in the meantime.
 *
 *  Gecko loses a message that was posted on a port BEFORE its peer was transferred to a worker if the
 *  sender closes within about a task of the transfer: post on port1, transfer port2, close port1 in
 *  the same tick, a microtask later or a `setTimeout(0)` later, and the worker never sees it. Posted
 *  after the transfer, the same message survives an immediate close, and Chromium and WebKit deliver
 *  it in every order, as the spec's "move the queue along with the port" says. Osra hits the losing
 *  order whenever a channel settles before its box has shipped, a signal aborted in the same tick as
 *  the call or a promise already resolved when it crossed, because the envelope carrying port2
 *  leaves in the microtask that delivers the EventPort message. Measured 2026-09-03 on Firefox 1532
 *  (Playwright), page to module worker; same-realm transfers are unaffected. So a local end holds
 *  its posts and its close until `markPortsShipped` sees the peer in a transfer list, then replays
 *  them in order, which is the order Gecko handles. */
type Shipping = { shipped: boolean, pending: Array<() => void> }

const unshippedRemotes = new WeakMap<object, Shipping>()

/** Called after a post with its transfer list: replays what the local end of every channel whose
 *  peer was in it did while unshipped. A peer that never ships keeps its local end open, and its
 *  posts unsent, until garbage collection. */
export const markPortsShipped = (transferables: readonly Transferable[]): void => {
  for (const transferable of transferables) {
    const shipping = unshippedRemotes.get(transferable)
    if (!shipping) continue
    unshippedRemotes.delete(transferable)
    shipping.shipped = true
    for (const replay of shipping.pending.splice(0)) replay()
  }
}

const createProtocolPort = <T>(
  port: TypedMessagePort<Capable>,
  ctx: RevivableContext,
  shipping?: Shipping,
): TypedMessagePort<T> => {
  const target = new EventTarget() as TypedMessagePort<T>
  const onMessage = ({ data }: MessageEvent<Capable>): void => {
    reviveInbound<T>(
      data,
      ctx,
      revived => target.dispatchEvent(new MessageEvent('message', { data: revived })),
      () => target.dispatchEvent(new Event('messageerror')),
    )
  }
  // A message the platform cannot deserialize (e.g. Gecko dropping a transferred VideoFrame)
  // is silently discarded by the port; forward it so consumers can error instead of losing data.
  const onMessageError = (): void => {
    target.dispatchEvent(new Event('messageerror'))
  }
  const onClose = (): void => {
    target.dispatchEvent(new Event('close'))
  }
  port.addEventListener('message', onMessage)
  port.addEventListener('messageerror', onMessageError as EventListener)
  port.addEventListener('close', onClose as EventListener)
  target.postMessage = (data: T, opt?: Transferable[] | StructuredSerializeOptions) => {
    // outsideTransfer: a fresh walk - move semantics come from wrappers in `data` (e.g.
    // forceTransfer-marked chunks), never from an extent that happens to be on the stack
    const boxed = outsideTransfer(() => recursiveBox(data as Capable, ctx))
    const transferables = getTransferableObjects(boxed)
    const extra = Array.isArray(opt) ? opt : []
    const transferList = extra.length ? [...transferables, ...extra] : transferables
    const post = () => {
      port.postMessage(boxed, transferList)
      markPortsShipped(transferList)
    }
    if (shipping && !shipping.shipped) { shipping.pending.push(post); return }
    post()
  }
  target.start = () => port.start()
  const close = () => {
    port.removeEventListener('message', onMessage)
    port.removeEventListener('messageerror', onMessageError as EventListener)
    port.removeEventListener('close', onClose as EventListener)
    port.close()
  }
  target.close = () => {
    if (shipping && !shipping.shipped) { shipping.pending.push(close); return }
    close()
  }
  return target
}

/** Factory for revivable-internal channels. Returns a local port that
 *  auto-boxes live values regardless of transport, plus a pre-boxed remote
 *  port the revivable embeds in its Boxed* structure. */
export const createRevivableChannel = <T extends Capable>(
  context: RevivableContext,
): { localPort: AnyPort<T>, boxedRemote: BoxedMessagePort<T> } => {
  if (isJsonOnlyTransport(context.transport)) {
    const { port1, port2 } = new EventChannel<T, T>()
    return {
      localPort: port1,
      boxedRemote: box(port2 as StructurableTransferablePort<T>, context),
    }
  }
  const { port1, port2 } = new MessageChannel() as unknown as TypedMessageChannel<Capable, Capable>
  const shipping: Shipping = { shipped: false, pending: [] }
  unshippedRemotes.set(port2, shipping)
  return {
    localPort: createProtocolPort<T>(port1, context, shipping) as unknown as AnyPort<T>,
    boxedRemote: box(port2 as unknown as StructurableTransferablePort<T>, context, { autoBox: true }),
  }
}

const reviveViaPortId = <T extends Capable>(
  portId: Uuid,
  context: RevivableContext,
  synthetic: boolean,
): TypedMessagePort<T> => {
  const state = getState(context)
  const { port1: userPort, port2: internalPort } =
    synthetic
      ? new EventChannel<T, T>()
      : new MessageChannel() as unknown as TypedMessageChannel<T, T>
  const userPortRef = new WeakRef(userPort)
  // for synthetic EventChannels internalPort._peer === userPort, so holding internalPort strongly from the trackGc cleanup would re-pin userPort
  const internalPortRef = new WeakRef(internalPort)

  let cleanedUp = false
  const performCleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    tombstonePort(state, portId)
    const internal = internalPortRef.deref()
    internal?.removeEventListener('message', internalPortListener as EventListener)
    internal?.close()
    unregisterGc?.()
  }

  const handler = (message: Messages) => {
    if (message.type === 'message-port-close') {
      performCleanup()
      const user = userPortRef.deref()
      user?.dispatchEvent(new Event('close'))
      user?.close()
      return
    }
    if (!userPortRef.deref()) {
      performCleanup()
      return
    }
    const internal = internalPortRef.deref()
    if (!internal) return
    reviveInbound<T>(
      message.data,
      context,
      revived => postRevived(internal, revived, synthetic),
      () => userPortRef.deref()?.dispatchEvent(new Event('messageerror')),
    )
  }

  const internalPortListener = ({ data }: MessageEvent<T>) => {
    context.sendMessage({
      type: 'message',
      remoteUuid: context.remoteUuid,
      data: boxUnlessPreBoxed(data as Capable, context),
      portId,
      seq: nextOutSeq(context, portId),
    })
  }

  const unregisterGc = trackGc(userPort, () => {
    sendClose(context, portId)
    performCleanup()
  })

  if (userPort instanceof EventPort) {
    userPort._onClose = () => {
      if (cleanedUp) return
      sendClose(context, portId)
      performCleanup()
    }
  }

  internalPort.addEventListener('message', internalPortListener as EventListener)
  internalPort.start()

  registerPortHandler(context, portId, handler)

  return userPort
}

const typeCheck = () => {
  const port = {} as TypedMessagePort<{ foo: string }>
  const boxed = box(port, {} as RevivableContext)
  const revived = revive(boxed, {} as RevivableContext)
  const expected: AnyPort<{ foo: string }> = revived
  // @ts-expect-error - wrong message type
  const wrongType: AnyPort<{ bar: number }> = revived
  box({} as TypedMessagePort<Promise<string>>, {} as RevivableContext)
}
