import type { Context, Transport } from '../utils/transport.js'
import type { DefaultRevivableModules, RevivableModule } from '../revivables/index.js'
import type { DeepReplaceWithBox } from '../utils/replace.js'
import type { ProtocolContext } from './utils.js'
import type {
  Capable, MessageEventTarget, MessageFields,
  MessageVariant, Uuid,
} from '../types.js'

import { recursiveBox, recursiveRevive } from '../revivables/index.js'
import { outsideTransfer } from '../revivables/transfer.js'
import { isEmitTransport, isReceiveTransport } from '../utils/type-guards.js'
import { runTeardown } from '../utils/teardown.js'

export const type = 'bidirectional' as const

export type InitMessage<
  TModules extends readonly RevivableModule[] = DefaultRevivableModules,
  T extends Capable<TModules> = Capable<TModules>
> = {
  type: 'init'
  remoteUuid: Uuid
  data: DeepReplaceWithBox<T, TModules[number]>
}

export declare const Messages: <
  TModules extends readonly RevivableModule[] = DefaultRevivableModules,
  T extends Capable<TModules> = Capable<TModules>
>(modules: TModules, value: T) =>
  | InitMessage<TModules, T>

export type Messages<
  TModules extends readonly RevivableModule[] = DefaultRevivableModules,
  T extends Capable<TModules> = Capable<TModules>
> = ReturnType<typeof Messages<TModules, T>>

export type ConnectionContext<
  TModules extends readonly RevivableModule[] = DefaultRevivableModules
> = {
  type: 'bidirectional'
  eventTarget: MessageEventTarget<TModules>
  connection: BidirectionalConnection<TModules>
}

export type ConnectionRevivableContext<
  TModules extends readonly RevivableModule[] = DefaultRevivableModules
> = {
  transport: Transport
  remoteUuid: Uuid
  sendMessage: (message: MessageFields & Record<string, unknown>) => void
  revivableModules: TModules
  eventTarget: MessageEventTarget<TModules>
}

export const startBidirectionalConnection = <
  TModules extends readonly RevivableModule[] = DefaultRevivableModules,
>(
  { transport, value, remoteUuid, eventTarget, send, revivableModules }:
  {
    transport: Transport
    value: Capable<TModules>
    remoteUuid: Uuid
    eventTarget: MessageEventTarget<TModules>
    send: (message: MessageFields & Record<string, unknown>) => void
    revivableModules: TModules
  },
) => {
  const revivableContext = {
    transport,
    remoteUuid,
    sendMessage: send,
    eventTarget,
    revivableModules
  } satisfies ConnectionRevivableContext<TModules>

  for (const module of revivableModules) {
    module.init?.(revivableContext)
  }

  const { promise, resolve } = Promise.withResolvers<InitMessage<TModules>['data']>()

  eventTarget.addEventListener('message', function listener ({ detail }) {
    if (detail.type === 'init') {
      resolve(detail.data)
      eventTarget.removeEventListener('message', listener)
    }
  })

  send({
    type: 'init',
    remoteUuid,
    data: outsideTransfer(() => recursiveBox(value, revivableContext))
  })

  return {
    revivableContext,
    remoteValue:
      promise
        .then(initData => recursiveRevive(initData, revivableContext) as Capable),
  }
}

export type BidirectionalConnection<
  TModules extends readonly RevivableModule[] = DefaultRevivableModules
> = {
  revivableContext: ConnectionRevivableContext<TModules>
  remoteValue: Promise<Capable>
}

/** Mounts bidirectional mode on the shared protocol context. Only active
 *  when the transport can both emit and receive. */
export const init = <TModules extends readonly RevivableModule[]>(
  ctx: ProtocolContext<TModules>
): void => {
  if (!(isEmitTransport(ctx.transport) && isReceiveTransport(ctx.transport))) return

  ctx.protocolEventTarget.addEventListener('message', ({ detail: { message, peer } }) => {
    if (message.type === 'announce') {
      if (!message.remoteUuid) {
        ctx.sendMessage({ type: 'announce', remoteUuid: message.uuid })
        return
      }
      if (message.remoteUuid !== ctx.getUuid()) return
      // Already-tracked uuid is the normal handshake-echo (peer re-announcing back after our reply), not a collision
      if (ctx.connectionContexts.has(message.uuid)) return
      ctx.sendMessage({ type: 'announce', remoteUuid: message.uuid })
      const eventTarget = ctx.createConnectionEventTarget()
      const connectionContextValues = { ...peer(), abort: () => ctx.abortConnection(message.uuid) }
      let connection: ReturnType<typeof startBidirectionalConnection<TModules>>
      try {
        // Built BEFORE the connection starts, because starting it sends our value: a factory that calls ctx.abort() has to be observable before the value goes out
        const built = ctx.valueFor(connectionContextValues)
        if (ctx.claimPendingAbort(message.uuid)) {
          ctx.sendMessage({ type: 'close', remoteUuid: message.uuid })
          return
        }
        connection = startBidirectionalConnection<TModules>({
          transport: ctx.transport,
          value: built,
          remoteUuid: message.uuid,
          eventTarget,
          send: (m) => ctx.sendMessage(m as MessageVariant),
          revivableModules: ctx.revivableModules
        })
      } catch (error) {
        // Surface it locally instead of swallowing it inside EventTarget dispatch, AND tell the peer, or its own expose() waits on a handshake that will never come
        ctx.sendMessage({ type: 'close', remoteUuid: message.uuid })
        ctx.rejectRemoteValue(error)
        return
      }
      const connectionContext = {
        type: 'bidirectional',
        eventTarget,
        connection,
      } satisfies ConnectionContext<TModules>
      ctx.connectionContexts.set(message.uuid, connectionContext)
      connectionContext.connection.remoteValue.then(
        (remoteValue) => ctx.addConnection(connectionContextValues, remoteValue),
        (error) => ctx.rejectRemoteValue(error),
      )
      return
    }
    if (message.type === 'close') {
      if (message.remoteUuid !== ctx.getUuid()) return
      const connectionContext = ctx.connectionContexts.get(message.uuid)
      if (!connectionContext) return
      ctx.connectionContexts.delete(message.uuid)
      runTeardown(connectionContext.connection.revivableContext)
      // No-op when the handshake already resolved; a close that beats init must not leave the caller pending forever
      ctx.rejectRemoteValue(new Error('osra: peer closed the connection'))
      return
    }
    if (message.remoteUuid !== ctx.getUuid()) return
    const connection = ctx.connectionContexts.get(message.uuid)
    if (!connection) return
    connection.eventTarget.dispatchEvent(
      new CustomEvent('message', { detail: message })
    )
  })

  if (ctx.presetRemoteUuid !== undefined) {
    const presetRemoteUuid = ctx.presetRemoteUuid
    const eventTarget = ctx.createConnectionEventTarget()
    let connection: ReturnType<typeof startBidirectionalConnection<TModules>>
    let presetContextValues: Context
    try {
      presetContextValues = { abort: () => ctx.abortConnection(presetRemoteUuid) }
      const built = ctx.valueFor(presetContextValues)
      if (ctx.claimPendingAbort(presetRemoteUuid)) {
        ctx.sendMessage({ type: 'close', remoteUuid: presetRemoteUuid })
        return
      }
      connection = startBidirectionalConnection<TModules>({
        transport: ctx.transport,
        value: built,
        remoteUuid: ctx.presetRemoteUuid,
        eventTarget,
        send: (m) => ctx.sendMessage(m as MessageVariant),
        revivableModules: ctx.revivableModules
      })
    } catch (error) {
      ctx.sendMessage({ type: 'close', remoteUuid: presetRemoteUuid })
      ctx.rejectRemoteValue(error)
      return
    }
    const connectionContext = {
      type: 'bidirectional',
      eventTarget,
      connection,
    } satisfies ConnectionContext<TModules>
    ctx.connectionContexts.set(ctx.presetRemoteUuid, connectionContext)
    connectionContext.connection.remoteValue.then(
      (remoteValue) => ctx.addConnection(presetContextValues, remoteValue),
      (error) => ctx.rejectRemoteValue(error),
    )
    return
  }

  // Posted with '*' instead of the configured origin: until a cross-origin iframe commits, its window still holds the initial about:blank document, so a strict targetOrigin fails the browser's delivery check
  let announceDelay = 50
  let announceTimeout: ReturnType<typeof setTimeout> | undefined
  const announce = () => {
    if (ctx.unregisterSignal?.aborted || ctx.connectionContexts.size > 0) return
    try { ctx.sendMessage({ type: 'announce' }, '*') } catch {}
    announceTimeout = setTimeout(announce, announceDelay)
    announceDelay = Math.min(announceDelay * 2, 1_000)
  }
  ctx.unregisterSignal?.addEventListener('abort', () => clearTimeout(announceTimeout), { once: true })
  announce()
}
