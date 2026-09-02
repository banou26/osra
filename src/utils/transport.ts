import type { Message} from '../types.js'
import type {
  WebExtGlobal, WebExtOnConnect, WebExtOnMessage,
  WebExtPort, WebExtRuntime, WebExtSender
} from './webext-types.js'

import { OSRA_DEFAULT_KEY, OSRA_KEY } from '../types.js'
import {
  isOsraMessage, isCustomTransport,
  isWebExtensionOnConnect, isWebExtensionOnMessage,
  isWebExtensionPort, isWebExtensionRuntime, isWebSocket, isWindow, isSharedWorker
} from './type-guards.js'

/** What the local side knows about the realm on the other end of a connection.
 *
 *  `origin` and `source` are only OBSERVABLE on window transports. A MessagePort message carries
 *  origin "" and source null, so for a port the identity has to be declared by whoever created the
 *  transport, which is the side that received the port over a trustworthy window message. That is why
 *  `expose` takes a `context` option rather than only reporting what it can see: without it, every
 *  port-based consumer would rebuild the same out-of-band handshake to learn who it is talking to. */
export type Context = {
  /** Tears down THIS connection and nothing else: the peer is sent a close, its revivables are torn
   *  down, and it stops being tracked. `unregisterSignal` is the whole-expose equivalent; this is the
   *  one a server reaches for when a single realm misbehaves or is finished with. */
  abort?: () => void
  origin?: string
  source?: MessageEventSource | null
  port?: MessagePort | WebExtPort
  sender?: WebExtSender
}

export type MessageContext = {
  port?: MessagePort | WebExtPort // WebExtension only
  sender?: WebExtSender // WebExtension only
  receiveTransport?: ReceivePlatformTransport
  source?: MessageEventSource | null // Window, Worker, WebSocket
  origin?: string // Window only
}

export type ReceiveHandler = (listener: (event: Message, messageContext: MessageContext) => void) => void | (() => void)
export type EmitHandler = (message: Message, transferables?: Transferable[]) => void

type CustomReceive = ReceivePlatformTransport | ReceiveHandler
type CustomEmit = EmitPlatformTransport | EmitHandler

export type CustomTransport =
  { isJson?: boolean }
  & (
    | { receive: CustomReceive, emit: CustomEmit }
    | { receive: CustomReceive }
    | { emit: CustomEmit }
  )

export type CustomEmitTransport = Extract<CustomTransport, { emit: any }>
export type CustomReceiveTransport = Extract<CustomTransport, { receive: any }>

export type EmitJsonPlatformTransport =
  | WebSocket
  | WebExtPort
  | WebExtRuntime

export type ReceiveJsonPlatformTransport =
  | WebSocket
  | WebExtPort
  | WebExtOnConnect
  | WebExtOnMessage
  | WebExtRuntime

export type JsonPlatformTransport =
  | { isJson: true }
  | EmitJsonPlatformTransport
  | ReceiveJsonPlatformTransport

// typed structurally because lib.webworker can't be loaded next to lib.dom (conflicting `self` declarations)
export type WorkerSelf = {
  postMessage(...args: any[]): void
  addEventListener(type: string, listener: (event: any) => void): void
  removeEventListener(type: string, listener: (event: any) => void): void
}

export type EmitPlatformTransport =
  | EmitJsonPlatformTransport
  | Window
  | ServiceWorker
  | Worker
  | SharedWorker
  | MessagePort
  | WorkerSelf

export type ReceivePlatformTransport =
  | ReceiveJsonPlatformTransport
  | Window
  | ServiceWorkerContainer
  | Worker
  | SharedWorker
  | MessagePort
  | WorkerSelf

export type PlatformTransport =
  | EmitPlatformTransport
  | ReceivePlatformTransport

export type EmitTransport = EmitPlatformTransport | CustomEmitTransport
export type ReceiveTransport = ReceivePlatformTransport | CustomReceiveTransport

export type Transport =
  | PlatformTransport
  | CustomTransport

// Structural shapes from ./webext-types, never the polyfill's own module types: an import of those
// would land in the published .d.ts, where the consumer may have nothing to resolve it to. Naming the
// ambient `browser`/`chrome` globals here would leak unresolvable names the same way.
type WebExtGlobals = { browser?: WebExtGlobal, chrome?: WebExtGlobal }
export const getWebExtensionGlobal = (): WebExtGlobal | undefined =>
  (globalThis as unknown as WebExtGlobals).browser ?? (globalThis as unknown as WebExtGlobals).chrome
export const getWebExtensionRuntime = () => getWebExtensionGlobal()?.runtime

export const checkOsraMessageKey = (message: any, key: string): message is Message =>
  isOsraMessage(message)
  && message[OSRA_KEY] === key

const onAbort = (signal: AbortSignal | undefined, fn: () => void) => {
  if (!signal) return
  if (signal.aborted) {
    fn()
    return
  }
  signal.addEventListener('abort', fn, { once: true })
}

export const registerOsraMessageListener = (
  { listener, transport, remoteName, key = OSRA_DEFAULT_KEY, origin = '*', unregisterSignal }:
  {
    listener: (message: Message, messageContext: MessageContext) => void
    transport: ReceiveTransport
    remoteName?: string
    key?: string
    origin?: string
    unregisterSignal?: AbortSignal
  }
) => {
  if (unregisterSignal?.aborted) return

  const receiveTransport: Extract<CustomTransport, { receive: any }>['receive'] =
    isCustomTransport(transport) ? transport.receive : transport

  if (typeof receiveTransport === 'function') {
    const unregister = receiveTransport((message, ctx) => {
      if (unregisterSignal?.aborted) return
      if (!checkOsraMessageKey(message, key)) return
      if (remoteName && message.name !== remoteName) return
      listener(message, ctx)
    })
    if (typeof unregister === 'function') onAbort(unregisterSignal, unregister)
    return
  }

  if (
    isWebExtensionRuntime(receiveTransport)
    || isWebExtensionPort(receiveTransport)
    || isWebExtensionOnConnect(receiveTransport)
    || isWebExtensionOnMessage(receiveTransport)
  ) {
    const listenOnWebExtOnMessage = (onMessage: WebExtOnMessage, port?: WebExtPort) => {
      const _listener = (message: unknown, sender?: WebExtSender) => {
        if (!checkOsraMessageKey(message, key)) return
        if (remoteName && message.name !== remoteName) return
        listener(message, { port, sender })
      }
      onMessage.addListener(_listener)
      onAbort(unregisterSignal, () => onMessage.removeListener(_listener))
    }

    if (isWebExtensionRuntime(receiveTransport)) {
      listenOnWebExtOnMessage(receiveTransport.onMessage)
    } else if (isWebExtensionOnConnect(receiveTransport)) {
      const _listener = (port: WebExtPort) =>
        listenOnWebExtOnMessage(port.onMessage as WebExtOnMessage, port)
      receiveTransport.addListener(_listener)
      onAbort(unregisterSignal, () => receiveTransport.removeListener(_listener))
    } else if (isWebExtensionOnMessage(receiveTransport)) {
      listenOnWebExtOnMessage(receiveTransport)
    } else {
      listenOnWebExtOnMessage(receiveTransport.onMessage as WebExtOnMessage)
    }
    return
  }

  // SharedWorker dispatches messages on its .port, not on the worker object
  const target = isSharedWorker(receiveTransport) ? receiveTransport.port : receiveTransport
  // Inbound origin filtering is a cross-origin *window* concern - WebSocket and ServiceWorkerContainer events carry their own unrelated origins
  const filterByOrigin = origin !== '*' && isWindow(receiveTransport)
  const messageListener = (event: MessageEvent<Message | string>) => {
    let data = event.data
    if (typeof data === 'string') {
      try { data = JSON.parse(data) as Message } catch { return }
    }
    if (!checkOsraMessageKey(data, key)) return
    if (remoteName && data.name !== remoteName) return
    if (filterByOrigin && event.origin && event.origin !== origin) return
    listener(data, { receiveTransport, source: event.source, origin: event.origin })
  }
  target.addEventListener('message', messageListener as EventListener)
  // addEventListener alone never enables a MessagePort's queue - only .start() or assigning onmessage does
  if (target instanceof MessagePort) target.start()
  onAbort(unregisterSignal, () =>
    target.removeEventListener('message', messageListener as EventListener),
  )
}

// A WebExtension port THROWS on postMessage once it is disconnected, where a MessagePort silently no-ops
// (measured: neither engine throws or logs for a MessagePort, in any disentanglement route). Firefox says
// "Attempt to postMessage on disconnected port", Chromium "Attempting to use a disconnected port object".
// Every message on a port transport funnels through here, so a revivable still talking while the other end
// tears down - a stream topping up its credit window - throws on every message, not once.
const disconnectedPorts = new WeakSet<WebExtPort>()

const isDisconnectedPortError = (error: unknown): boolean =>
  String((error as { message?: unknown })?.message ?? error).includes('disconnected port')

export const sendOsraMessage = (
  transport: EmitTransport,
  message: Message,
  origin = '*',
  transferables: Transferable[] = []
) => {
  const emitTransport: Extract<EmitTransport, { emit: any }>['emit'] =
    isCustomTransport(transport) ? transport.emit : transport

  if (typeof emitTransport === 'function') {
    emitTransport(message, transferables)
  } else if (isWindow(emitTransport)) {
    // Must check first - cross-origin windows throw on other property access
    emitTransport.postMessage(message, origin, transferables)
  } else if (isWebExtensionPort(emitTransport)) {
    // A disconnected port is ordinary teardown, not a fault; anything else here is a real bug and must stay visible
    if (disconnectedPorts.has(emitTransport)) return
    try {
      emitTransport.postMessage(message)
    } catch (error) {
      if (!isDisconnectedPortError(error)) throw error
      disconnectedPorts.add(emitTransport)
    }
  } else if (isWebExtensionRuntime(emitTransport)) {
    // Rejects while no receiver exists yet (announce retries) - swallow only that
    emitTransport.sendMessage(message)?.catch?.((error: unknown) => {
      if (!String((error as { message?: unknown })?.message).includes('Receiving end does not exist')) throw error
    })
  } else if (isWebSocket(emitTransport)) {
    const payload = JSON.stringify(message)
    if (emitTransport.readyState === WebSocket.CONNECTING) {
      emitTransport.addEventListener('open', () => emitTransport.send(payload), { once: true })
    } else {
      emitTransport.send(payload)
    }
  } else if (isSharedWorker(emitTransport)) {
    emitTransport.port.postMessage(message, transferables)
  } else {
    emitTransport.postMessage(message, transferables)
  }
}
