import type { DefaultRevivableModules, RevivableModule } from '../revivables/index.js'
import type { ConnectionContext as BidirectionalConnectionContext } from './bidirectional.js'
import type {
  Message, MessageVariant, Uuid,
  Capable,
} from '../types.js'
import type {
  ProtocolContext,
  StartConnectionsOptions,
} from './utils.js'
import type { MessageContext, Context } from '../utils/transport.js'
import type { Connected, Contextual, Exposed } from './utils.js'

import { OSRA_DEFAULT_KEY, OSRA_KEY } from '../types.js'
import * as bidirectional from './bidirectional.js'
import {
  isEmitTransport,
  isReceiveTransport,
} from '../utils/type-guards.js'
import { createTypedEventTarget } from '../utils/typed-event-target.js'
import { getTransferableObjects } from '../utils/transferable.js'
import { registerOsraMessageListener, sendOsraMessage } from '../utils/transport.js'
import { runTeardown } from '../utils/teardown.js'
import { markPortsShipped } from '../revivables/message-port.js'
import { asExposed, createConnectionQueue, isContextual, mergeRevivableModules, normalizeTransport, CONTEXT } from './utils.js'

// Explicit, not `export *`: this barrel is re-exported by the package root, and a star put protocol
// plumbing in osra's public namespace under names nobody would choose for it. `type` (the string
// 'bidirectional'), `init`, `startBidirectionalConnection`, `CONTEXT`, `asExposed`,
// `createConnectionQueue`, `isContextual`, `mergeRevivableModules` and `normalizeTransport` are all
// internal; import them from their own module if you are working inside osra.
export type {
  InitMessage, Messages,
  // not ConnectionContext: this module declares its own, which shadowed the star export anyway
  ConnectionRevivableContext, BidirectionalConnection,
} from './bidirectional.js'
export * from './relay.js'
export { context } from './utils.js'
export type {
  Connected, Contextual, Exposed, StartConnectionsOptions,
  ProtocolContext, ProtocolEventMap, ProtocolEventTarget, ConnectionQueue,
} from './utils.js'

export type ConnectionModule<T> = {
  readonly type: string
  // ProtocolContext<any> for the same bivariance reason as RevivableModule.box
  readonly init: (ctx: ProtocolContext<any>) => void
  readonly Messages?: T
}

// internal: the list of protocol modes the connection layer mounts
const connections = [
  bidirectional
] as const

export type DefaultConnectionModules = typeof connections
export type DefaultConnectionModule = DefaultConnectionModules[number]

export type ConnectionMessage<
  TModules extends readonly RevivableModule[] = DefaultRevivableModules,
  T extends Capable<TModules> = Capable<TModules>
> =
  DefaultConnectionModule extends {
    Messages: (modules: TModules, value: T) => infer R
  }
    ? R
    : never

export type ConnectionContext<
  TModules extends readonly RevivableModule[] = DefaultRevivableModules
> =
  | BidirectionalConnectionContext<TModules>

export const startConnections = <
  T = unknown,
  const TModules extends readonly RevivableModule[] = DefaultRevivableModules,
  TResult = T
>(
  value: Capable<TModules> | Contextual<Capable<TModules>>,
  {
    transport: _transport,
    name,
    remoteName,
    key = OSRA_DEFAULT_KEY,
    origin = '*',
    unregisterSignal,
    revivableModules: configureRevivableModules,
    uuid: _uuid,
    remoteUuid: presetRemoteUuid,
    // type-level counterpart is `TResult`'s default in src/index.ts: those two state the same fact separately and have to move together
    connection: selectConnection = ({ value }) => value,
  }: StartConnectionsOptions<TModules>
): Exposed<TResult> => {
  const select = selectConnection as (connected: Connected<T>) => TResult
  const transport = normalizeTransport(_transport)
  if (!(isEmitTransport(transport) && isReceiveTransport(transport))) {
    const queue = createConnectionQueue<T>()
    queue.close()
    const rejected = Promise.reject(new Error(
      'osra: transport must be able to both emit and receive to establish a connection'
      + '; pass a bidirectional platform transport or a custom { emit, receive } pair',
    ))
    rejected.catch(() => {})
    return asExposed<T, TResult>(rejected, queue, select)
  }
  const mergedRevivableModules = mergeRevivableModules<TModules>(configureRevivableModules)
  type MergedModules = typeof mergedRevivableModules
  const connectionContexts = new Map<string, ConnectionContext<MergedModules>>()

  const pendingAborts = new Set<string>()

  const connectionQueue = createConnectionQueue<T>()

  const { promise: firstConnection, resolve: resolveFirstConnection, reject: rejectRemoteValue } =
    Promise.withResolvers<Connected<T>>()
  // Keeps a fire-and-forget `expose(value, …)` from surfacing an unhandled rejection on abort/close
  firstConnection.catch(() => {})

  const uuid: Uuid = _uuid ?? globalThis.crypto.randomUUID()

  const sendEnvelope = (message: MessageVariant, targetOrigin: string = origin) => {
    const envelope = { [OSRA_KEY]: key, name, uuid, ...message }
    const transferables = getTransferableObjects(envelope)
    sendOsraMessage(transport, envelope, targetOrigin, transferables)
    // after the post, not before: a local end whose peer was just handed over may close now
    markPortsShipped(transferables)
  }

  const sendMessage = (message: MessageVariant, targetOrigin?: string) => {
    if (unregisterSignal?.aborted) return
    sendEnvelope(message, targetOrigin)
  }

  const protocolEventTarget = createTypedEventTarget<{ message: CustomEvent<{ message: Message<MergedModules>, peer: () => Context }> }>()

  const ctx: ProtocolContext<MergedModules> = {
    transport,
    valueFor: (peer: Context) =>
      (isContextual<Capable<MergedModules>>(value)
        ? value[CONTEXT](peer)
        : value) as Capable<MergedModules>,
    revivableModules: mergedRevivableModules,
    connectionContexts,
    getUuid: () => uuid,
    presetRemoteUuid,
    sendMessage,
    protocolEventTarget,
    rejectRemoteValue,
    abortConnection: (remoteUuid: Uuid) => {
      const connectionContext = connectionContexts.get(remoteUuid)
      // Raised from inside the value factory, which runs BEFORE the connection is registered
      if (!connectionContext) { pendingAborts.add(remoteUuid); return }
      connectionContexts.delete(remoteUuid)
      sendEnvelope({ type: 'close', remoteUuid })
      runTeardown(connectionContext.connection.revivableContext)
      rejectRemoteValue(new Error('osra: connection aborted'))
    },
    claimPendingAbort: (remoteUuid) => pendingAborts.delete(remoteUuid),
    addConnection: (ctx, value) => {
      const connection = { value: value as T, context: ctx }
      resolveFirstConnection(connection)
      connectionQueue.push(connection)
    },
    createConnectionEventTarget: createTypedEventTarget,
    unregisterSignal,
  }

  const listener = (message: Message, messageContext: MessageContext) => {
    if (message.uuid === uuid) return
    // Built from LOCAL knowledge only: nothing from the peer's payload participates, and none of it is ever sent back
    const peer = (): Context => ({
      ...(messageContext.origin ? { origin: messageContext.origin } : {}),
      ...(messageContext.source ? { source: messageContext.source } : {}),
      ...(messageContext.port ? { port: messageContext.port } : {}),
      ...(messageContext.sender ? { sender: messageContext.sender } : {}),
    })
    protocolEventTarget.dispatchEvent(
      new CustomEvent('message', { detail: { message: message as Message<MergedModules>, peer } }),
    )
  }

  registerOsraMessageListener({
    listener,
    transport,
    remoteName,
    key,
    origin,
    unregisterSignal
  })

  // an already-aborted signal's 'abort' event has fired and will never fire again, so the listener below would leave the promise pending forever
  if (unregisterSignal?.aborted) {
    rejectRemoteValue(unregisterSignal.reason)
    connectionQueue.close()
    return asExposed<T, TResult>(firstConnection, connectionQueue, select)
  }

  unregisterSignal?.addEventListener('abort', () => {
    for (const [peerUuid, connectionContext] of connectionContexts) {
      sendEnvelope({ type: 'close', remoteUuid: peerUuid as Uuid })
      runTeardown(connectionContext.connection.revivableContext)
    }
    connectionContexts.clear()
    // the other two exit paths close the queue; without this a `for await` over connections never terminates
    connectionQueue.close()
    rejectRemoteValue(unregisterSignal.reason)
  }, { once: true })

  for (const connectionModule of connections) {
    connectionModule.init(ctx)
  }

  return asExposed<T, TResult>(firstConnection, connectionQueue, select)
}
