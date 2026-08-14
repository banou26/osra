<p align="center">
  <h2 align="center">Osra</h2>
</p>

[Documentation](https://osra.banou.dev)

Strictly typed, ergonomic, and lightweight (13kb gzipped) RPC library in Typescript. Send complex types and call functions across contexts with inferred typing, pluggable transports.

TL;DR: Osra makes your multi-context code looks like normal code. Zero boilerplate and gives you the best error messages you've ever seen.

`worker.ts`
```typescript
import { expose } from 'osra'

const payload = {
  hash: crypto.getRandomValues(new Uint8Array(10)),
  add: (a: number, b: number) => a + b,
  makeCounter: () => {
    let count = 0
    return () => ++count
  },
  streamData: async function* () { yield* [0, 1, 2] }
}
export type Payload = typeof payload

expose(payload, { transport: globalThis })
```

`main.ts`
```typescript
import type { Payload } from './worker'
import { expose } from 'osra'

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })

export const {
  hash, // Uint8Array
  add, // (a: number, b: number) => Promise<number>
  makeCounter, // () => Promise<() => Promise<number>>,
  streamData, // () => Promise<AsyncIterableIterator<number>>
} = await expose<Payload>({}, { transport: worker })

hash.byteLength // 10

await add(40, 2) // 42

const counter = await makeCounter()
await counter() // 1
await counter() // 2

for await (const n of await streamData()) {
  console.log(n) // 0, 1, 2
}
```

## Features

- **Efficient transport modes**:
  - Structured-clone (default for `Window`, `Worker`, [etc...](#transport-modes)) is the fastest transport mode, being able to clone and transfer values to other contexts efficiently.
  - JSON (default for `WebSocket`, WebExtensions, [etc...](#transport-modes)) is slower but supports more transport targets (e.g WebSocket, WebExtensions, etc...).

- **Wide type support**: Support all of the native platform types like `Function`, `Promise`, `ReadableStream`, `Response`, `Map`, `Uint8Array`, and [many more](#supported-types)...

- **Explicit typescript errors**: The codebase is entirely and extensively strictly typed. Anything that CAN cause issues at runtime will throw compile time errors.

As an example, trying to transfer a `File` value over a JSON transport, like so, will throw a compile time error:
```typescript
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ ... {                                                                                                   │
│   [ErrorMessage]: "Value type is only supported on structured-clone transports, not on JSON transports";│
│   [BadValue]: File;                                                                                     │
│   [Path]: "foo";                                                                                        │
│   [ParentObject]: { ...; };                                                                             │
│ }'.                                                                                                     │
│   Type '{ foo: File; }' ...                                                                             │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────┘
       ^^^^^^^^^^^^^^^^^^^^^^^^^
expose({ foo: new File([], '') }, { transport: new WebSocket('') })
```

- **Extensive automated test suite** on Chromium, Firefox, and WebKit via Playwright

## Transport modes

- **Structured-clone** (
[Window](https://developer.mozilla.org/en-US/docs/Web/API/Window),
[Worker](https://developer.mozilla.org/en-US/docs/Web/API/Worker/Worker),
[SharedWorker](https://developer.mozilla.org/en-US/docs/Web/API/SharedWorker),
[ServiceWorker](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorker),
[MessagePort](https://developer.mozilla.org/en-US/docs/Web/API/MessagePort),
custom transports)
- **JSON** (
[WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket),
[WebExtension runtime](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions) `connect()` and `onMessage`,
[WebExtension port](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/Port),
custom transports with `isJson: true`)

## Supported types

Transports are either **structured-clone** (Worker, Window, MessagePort, SharedWorker) or **JSON** (WebSocket, web extension messaging, custom transports with `isJson: true`).

| Type | Clone | JSON | Notes |
|---|---|---|---|
| JSON primitives, plain objects, arrays | ✅ | ✅ | |
| `undefined`, `NaN`, `±Infinity` | ✅ | ✅ | |
| `Date`, `BigInt`, `Map`, `Set` | ✅ | ✅ | |
| `ArrayBuffer`, `Int8Array`, `Uint8Array`, `Uint8ClampedArray`, `Int16Array`, `Uint16Array`, `Int32Array`, `Uint32Array`, `Float16Array`, `Float32Array`, `Float64Array`, `BigInt64Array`, `BigUint64Array` | ✅ | ✅ | |
| `Error` + subclasses | ✅ | ✅ | built-ins errors properly preserve their subclass; custom error classes becomes generic `Error` |
| `Symbol` | ✅ | ✅ | `Symbol.for` properly preserves the Symbol's key; `Symbol()` is automatically wrapped with [`identity()`](#identity) |
| `RegExp` | ✅ | ❌ | |
| `SharedArrayBuffer` | ✅ | ❌ | |
| Function | ✅ | ✅ | becomes `(...args) => Promise<result>`; arguments and results are properly handled too |
| `Promise` | ✅ | ✅ | |
| Async generators / async iterables | ✅ | ✅ | |
| `ReadableStream` | ✅ | ✅ | |
| `WritableStream` | ✅ | ✅ | |
| `MessagePort` | ✅ | ✅ | |
| `AbortSignal` | ✅ | ✅ | |
| `File` / `FileList` / `Blob` | ✅ | ❌ | |
| `Request` / `Response` / `Headers` | ✅ | ✅ | |
| `Event` / `CustomEvent` | ✅ | ✅ | Event subclass is not preserved |
| `EventTarget` | ✅ | ✅ | revives as a listener-only façade: `add`/`removeEventListener` proxy to the source; you can't dispatch through it |
| Structured-clonables (`ImageData`, `DOMRect`, `CryptoKey`, …) | ✅ | ❌ | |
| Transfer-only host objects (`OffscreenCanvas`, `MediaStreamTrack`, `RTCDataChannel`, …) | ✅ | ❌ | |
| `ImageBitmap`, `VideoFrame`, `AudioData` | ✅ | ❌ | |
| `WeakMap` / `WeakSet`, other unclonables | ❌ | ❌ | |


## Identity

`identity(value)` preserves reference equality across contexts, sending the same identity wrapped value twice results in the same object reference on the peer.

`worker.ts`
```ts
import { expose, identity } from 'osra'

const value = { foo: 'bar' }
const payload = { value, ref1: identity(value), ref2: identity(value) }

expose(payload, { transport: globalThis })
export type Payload = typeof payload
```

`main.ts`
```ts
import type { Payload } from './worker'
import { expose } from 'osra'

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
const { value, ref1, ref2 } = await expose<Payload>({}, { transport: worker })

value === ref1 // false
ref1 === ref2 // true
```


## Transfer

By default, osra will always copy values, if the value you want to send is a [transferable](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects), wrapping it with `transfer(value)` will properly transfer it to the other context. [Transfer behavior](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage#transfer) is preserved, which means the value can no longer be used in the sender context once it has been transferred.

```ts
import { transfer } from 'osra'

const buffer = new ArrayBuffer(16_000_000)
await remote.transferBuffer(transfer(buffer)) // moved - buffer is detached locally
```

### Options

| Option | Default | Description |
|---|---|---|
| `transport` | required | The channel to communicate over (see [Transport modes](#transport-modes)), should be equal to the place where `addEventListener('message')` and `postMessage()` calls target the remote context you want to communicate with |
| `key` | `'__OSRA_DEFAULT_KEY__'` | Namespacing tag that lets multiple independent osra connections share one channel |
| `origin` | `'*'` | Similar to [`postMessage`'s `origin`](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage#origin), It restricts the remote origin |
| `name` | - | Defines the name that will be used for the announcement |
| `remoteName` | - | Filters any incoming messages that are not equal to the `name` of the remote peer |
| `unregisterSignal` | - | `AbortSignal` that will tear down the connection when aborted |
| `uuid` / `remoteUuid` | random / - | Same as `name` and `remoteName`, but automatically generated at announce time |
| `revivableModules` | - | `defaults => modules` function to add, drop, reorder, or override revivable modules |
| `connection` | `({ value }) => value` | What one connection resolves to, for the await and for iteration alike (see [Connections](#connections)) |

## Connections

`expose()` is awaitable and async-iterable. Awaiting gives the first peer, iterating gives every peer as it connects:

```typescript
import { expose } from 'osra'

type PeerApi = { version: () => string }

const api = { log: (line: string) => console.log(line) }

// the first peer to connect
const remote = await expose<PeerApi>(api, { transport: window })
await remote.version()

// every peer, as each one arrives
for await (const peer of expose<PeerApi>(api, { transport: window })) {
  console.log('peer connected, running', await peer.version())
}
```

Each loop is one peer, so a page embedding several iframes serves them all from one `expose()`. Several loops over the same `expose()` each see every peer, and peers that connect before anything iterates are buffered and replayed.

Pass `connection` to decide what a peer resolves to, which is also how you reach its origin and its per-peer `abort`:

```typescript
for await (const peer of expose({}, {
  transport: window,
  connection: ({ value, context }) => ({ value, context })
})) {
  if (!allowed(peer.context.origin)) peer.context.abort?.()
}
```

The context holds only what the transport observed, plus `abort`. A window or iframe gives `origin` and `source`; a WebExtension gives `port` and `sender`; a WebSocket gives the socket URL as `origin`; a `MessagePort` or `Worker` observes nothing at all.

Wrap a value in `context()` to build it once per connection, so one server can answer each realm differently instead of sharing one object with all of them:

```typescript
import { expose, context } from 'osra'

expose(context(({ origin }) => ({ read: readFor(origin) })), { transport: window })
```

It runs before your value is sent, so calling `ctx.abort()` inside it refuses that peer outright.

## Limitations

- **Circular structures throw** a `TypeError` at send time; break the cycle or restructure.
- **Classes/prototypes are not preserved**: Classes and their instances are not preserved, please use plain objects and functions instead.
- **Synchronous functions become asynchronous**: `() => number` will become `() => Promise<number>`.
