import type { Message } from '../types.js'
import type {
  CustomEmitTransport, CustomReceiveTransport,
  CustomTransport, EmitJsonPlatformTransport,
  EmitTransport, JsonPlatformTransport,
  ReceiveJsonPlatformTransport,
  ReceiveTransport, Transport
} from './transport.js'
import type {
  WebExtOnConnect, WebExtOnMessage, WebExtPort, WebExtRuntime, WebExtSender
} from './webext-types.js'

import { OSRA_KEY } from '../types.js'
import { getWebExtensionRuntime } from './transport.js'

/** Structural on purpose, never `typeof Float16Array`. That global type exists only in TypeScript's
 *  esnext lib, and naming it here lands it in the SHIPPED declarations, where a consumer on an older
 *  lib gets `Cannot find name 'Float16ArrayConstructor'` inside osra's own .d.ts, and every check
 *  built on the collapsed types degrades with it. Same shape of break as the webextension-polyfill
 *  import 0.6.6 and 0.6.7 shipped; `npm run check-consumer-types-legacy-lib` is the guard. */
type Float16ArrayConstructorLike =
  & (new (buffer: ArrayBufferLike, byteOffset?: number, length?: number) => ArrayBufferView & { readonly length: number })
  & { readonly BYTES_PER_ELEMENT: number }

// Pulled from globalThis so module evaluation does not crash on platforms that have not shipped Float16Array yet (Node <= 23, Chrome <= 134, Firefox <= 128)
const Float16ArrayCtor: Float16ArrayConstructorLike | undefined =
  (globalThis as { Float16Array?: Float16ArrayConstructorLike }).Float16Array

const typedArrayConstructorsByName = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float16Array: Float16ArrayCtor,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
} as const

export type TypedArrayType = keyof typeof typedArrayConstructorsByName
export type TypedArrayConstructor = NonNullable<(typeof typedArrayConstructorsByName)[TypedArrayType]>
export type TypedArray = InstanceType<TypedArrayConstructor>

const typedArrayConstructors = Object.values(typedArrayConstructorsByName)

export const typedArrayToType = (value: TypedArray): TypedArrayType => {
  const name = value.constructor.name as TypedArrayType
  if (name in typedArrayConstructorsByName) return name
  // Subclasses (e.g. Node's Buffer extends Uint8Array) resolve to the nearest TypedArray ancestor
  for (const [ancestorName, ctor] of Object.entries(typedArrayConstructorsByName)) {
    if (ctor && value instanceof ctor) return ancestorName as TypedArrayType
  }
  throw new Error('Unknown typed array type')
}

export const typedArrayTypeToTypedArrayConstructor = (value: TypedArrayType): TypedArrayConstructor => {
  const ctor = typedArrayConstructorsByName[value]
  if (!ctor) throw new Error('Unknown typed array type')
  return ctor
}

export const isTypedArray = (value: unknown): value is TypedArray =>
  instanceOfAny(value, typedArrayConstructors)
export const isWebSocket = (value: unknown): value is WebSocket => value instanceof WebSocket
export const isServiceWorkerContainer = (value: unknown): value is ServiceWorkerContainer => !!globalThis.ServiceWorkerContainer && value instanceof ServiceWorkerContainer
export const isServiceWorker = (value: unknown): value is ServiceWorker => !!globalThis.ServiceWorker && value instanceof ServiceWorker
export const isWorker = (value: unknown): value is Worker => !!globalThis.Worker && value instanceof Worker
export type DedicatedWorkerGlobalScopeLike = typeof globalThis & {
  postMessage: (message: unknown, transfer?: Transferable[]) => void
  name: string
}
export const isDedicatedWorker = (value: unknown): value is DedicatedWorkerGlobalScopeLike => {
  const scope = (globalThis as { DedicatedWorkerGlobalScope?: abstract new (...args: never[]) => unknown }).DedicatedWorkerGlobalScope
  return !!scope && value instanceof scope
}
export const isSharedWorker = (value: unknown): value is SharedWorker => !!globalThis.SharedWorker && value instanceof SharedWorker
const isMessagePort = (value: unknown): value is MessagePort => value instanceof MessagePort

export const isOsraMessage = (value: unknown): value is Message =>
  !!value
  && typeof value === 'object'
  && OSRA_KEY in value
  && !!value[OSRA_KEY]

type AnyConstructor = abstract new (...args: any[]) => unknown

/** True if `value` is an instance of any of the given constructors.
 *  Tolerates undefined entries (constructors missing on this platform). */
export const instanceOfAny = (value: unknown, ctors: readonly (AnyConstructor | undefined)[]): boolean => {
  // `instanceof` is false for every primitive by definition, and this runs on every leaf of every
  // boxed value, several times over, so the walk should not pay for a dozen prototype lookups to
  // learn that a string is not an ImageBitmap.
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
  for (const ctor of ctors) if (ctor && value instanceof ctor) return true
  return false
}

export const isSharedArrayBuffer = (value: unknown): boolean =>
  instanceOfAny(value, [globalThis.SharedArrayBuffer])

// Some entries are also clonable (ArrayBuffer, ImageBitmap, …) - outside a `transfer` box they fall back to clone
export const isTransferable = (value: unknown): value is Transferable =>
  instanceOfAny(value, [
    globalThis.ArrayBuffer,
    globalThis.MessagePort,
    globalThis.ReadableStream,
    globalThis.WritableStream,
    globalThis.TransformStream,
    globalThis.ImageBitmap,
    globalThis.OffscreenCanvas,
    (globalThis as { AudioData?: abstract new (...args: any[]) => unknown }).AudioData,
    (globalThis as { VideoFrame?: abstract new (...args: any[]) => unknown }).VideoFrame,
    (globalThis as { MediaSourceHandle?: abstract new (...args: any[]) => unknown }).MediaSourceHandle,
    (globalThis as { MediaStreamTrack?: abstract new (...args: any[]) => unknown }).MediaStreamTrack,
    (globalThis as { MIDIAccess?: abstract new (...args: any[]) => unknown }).MIDIAccess,
    (globalThis as { RTCDataChannel?: abstract new (...args: any[]) => unknown }).RTCDataChannel,
    (globalThis as { WebTransportReceiveStream?: abstract new (...args: any[]) => unknown }).WebTransportReceiveStream,
    (globalThis as { WebTransportSendStream?: abstract new (...args: any[]) => unknown }).WebTransportSendStream,
  ])

export type { WebExtRuntime, WebExtPort, WebExtSender, WebExtOnConnect, WebExtOnMessage, WebExtEvent, WebExtGlobal } from './webext-types.js'

export const isWebExtensionRuntime = (value: unknown): value is WebExtRuntime => {
  const runtime = getWebExtensionRuntime()
  if (!runtime) return false
  return value === runtime
}

export const isWebExtensionPort = (value: unknown, connectPort: boolean = false): value is WebExtPort => {
  if (!value || typeof value !== 'object') return false
  // prevents a SecurityError when `value` is a cross-origin window - the property probes below would throw; no test covers this guard (the cross-origin tests only cover isJsonOnlyTransport and normalizeTransport), so it reads as dead code
  if (isWindow(value)) return false
  if (!('name' in value) || !('disconnect' in value) || !('postMessage' in value)) return false
  if (!connectPort) return true
  return 'sender' in value && 'onMessage' in value && 'onDisconnect' in value
}

const hasListenerApi = (value: unknown): boolean =>
  !!value
  && typeof value === 'object'
  && !isWindow(value)
  && 'addListener' in value
  && 'hasListener' in value
  && 'removeListener' in value

// Identity-compare against runtime.onConnect - structural checks can't distinguish onConnect from onMessage, which share the exact same shape
export const isWebExtensionOnConnect = (value: unknown): value is WebExtOnConnect => {
  const runtime = getWebExtensionRuntime()
  if (!runtime) return false
  return value === runtime.onConnect || value === runtime.onConnectExternal
}

export const isWebExtensionOnMessage = (value: unknown): value is WebExtOnMessage =>
  hasListenerApi(value)

export const isWindow = (value: unknown): value is Window => {
  if (!value || typeof value !== 'object') return false
  try {
    return 'window' in value && value.window === value
  } catch {
    // Cross-origin Window access can throw SecurityError - fall back to a shape probe over properties that don't trigger the security check
    try {
      return 'closed' in value
        && typeof value.closed === 'boolean'
        && 'close' in value
        && typeof value.close === 'function'
    } catch {
      return false
    }
  }
}

export const isEmitJsonOnlyTransport = (value: unknown): value is EmitJsonPlatformTransport =>
     isWebSocket(value)
  || isWebExtensionPort(value)
  || isWebExtensionRuntime(value)

export const isReceiveJsonOnlyTransport = (value: unknown): value is ReceiveJsonPlatformTransport =>
     isWebSocket(value)
  || isWebExtensionPort(value)
  || isWebExtensionOnConnect(value)
  || isWebExtensionOnMessage(value)
  || isWebExtensionRuntime(value)

export type IsJsonOnlyTransport<T extends Transport> = T extends JsonPlatformTransport ? true : false
export const isJsonOnlyTransport = (value: unknown): value is Extract<Transport, JsonPlatformTransport> =>
     (!!value && typeof value === 'object' && !isWindow(value) && 'isJson' in value && value.isJson === true)
  || isEmitJsonOnlyTransport(value)
  || isReceiveJsonOnlyTransport(value)

export const isEmitTransport = (value: unknown): value is EmitTransport =>
     isWindow(value)
  || isEmitJsonOnlyTransport(value)
  || isServiceWorker(value)
  || isWorker(value)
  || isDedicatedWorker(value)
  || isSharedWorker(value)
  || isMessagePort(value)
  || isCustomEmitTransport(value)

export function assertEmitTransport(transport: Transport): asserts transport is EmitTransport {
  if (!isEmitTransport(transport)) throw new Error('Transport is not emitable')
}

export const isReceiveTransport = (value: unknown): value is ReceiveTransport =>
     isWindow(value)
  || isReceiveJsonOnlyTransport(value)
  || isServiceWorkerContainer(value)
  || isWorker(value)
  || isDedicatedWorker(value)
  || isSharedWorker(value)
  || isMessagePort(value)
  || isCustomReceiveTransport(value)

export function assertReceiveTransport(transport: Transport): asserts transport is ReceiveTransport {
  if (!isReceiveTransport(transport)) throw new Error('Transport is not receiveable')
}

// Custom transports must be plain objects: Node's worker_threads MessagePort (an EventEmitter) has an inherited `emit` and would otherwise be misclassified
const isPlainObjectShape = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object') return false
  // a cross-origin window's [[GetPrototypeOf]] returns null, which would pass the proto check
  if (isWindow(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export const isCustomEmitTransport = (value: unknown): value is CustomEmitTransport => {
  if (!isPlainObjectShape(value)) return false
  if (!('emit' in value)) return false
  return isEmitTransport(value.emit) || typeof value.emit === 'function'
}

export const isCustomReceiveTransport = (value: unknown): value is CustomReceiveTransport => {
  if (!isPlainObjectShape(value)) return false
  if (!('receive' in value)) return false
  return isReceiveTransport(value.receive) || typeof value.receive === 'function'
}

export const isCustomTransport = (value: unknown): value is CustomTransport =>
     isCustomEmitTransport(value)
  || isCustomReceiveTransport(value)

export const isTransport = (value: unknown): value is Transport =>
     isEmitTransport(value)
  || isReceiveTransport(value)
  || isCustomTransport(value)
  || isJsonOnlyTransport(value)
