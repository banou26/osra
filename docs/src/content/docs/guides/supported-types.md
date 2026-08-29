---
title: Supported types
description: What you can send across a connection, and which types need a structured transport.
---

Osra supports transmitting almost all of the Web platform's values.\
If you try to use a value that your transport does not support, osra's type system will reject it at compile time with a nice error message.

| Type | Structured | JSON | Notes |
|---|---|---|---|
| Strings, numbers, booleans, `null`, plain objects, arrays | ✅ | ✅ | |
| `undefined`, `NaN`, `±Infinity` | ✅ | ✅ | Kept intact on JSON too, where `JSON.stringify` would lose them |
| `Date` | ✅ | ✅ | |
| `bigint` | ✅ | ✅ | |
| `Map`, `Set` | ✅ | ✅ | Keys and values go through the same treatment |
| `ArrayBuffer`, `Int8Array`, `Uint8Array`, `Uint8ClampedArray`, `Int16Array`, `Uint16Array`, `Int32Array`, `Uint32Array`, `Float16Array`, `Float32Array`, `Float64Array`, `BigInt64Array`, `BigUint64Array` | ✅ | ✅ | base64 encoded on JSON |
| `Error` and built-in subclasses | ✅ | ✅ | Built-in classes keep their class, your own become a plain `Error` |
| `symbol` | ✅ | ✅ | `Symbol.for` keeps its key, `Symbol()` keeps its identity |
| Function | ✅ | ✅ | Becomes `(...args) => Promise<result>`, arguments and results included |
| `Promise` | ✅ | ✅ | |
| Async generators and async iterables | ✅ | ✅ | |
| `ReadableStream`, `WritableStream` | ✅ | ✅ | Proxied chunk by chunk, not moved; [`transfer()`](/guides/identity-and-transfer/) moves each chunk's buffers |
| `MessagePort` | ✅ | ✅ | |
| `AbortSignal` | ✅ | ✅ | |
| `Request`, `Response`, `Headers` | ✅ | ✅ | Bodies stream |
| `Event`, `CustomEvent` | ✅ | ✅ | The `Event` subclass is not preserved |
| `EventTarget` | ✅ | ✅ | Arrives as a listener-only façade |
| `Blob`, `File`, `FileList` | ✅ | ❌ | Send an `ArrayBuffer` on JSON |
| `RegExp`, `DataView` | ✅ | ❌ | |
| `SharedArrayBuffer` | ✅ | ❌ | Stays shared memory across both contexts |
| `TransformStream` | ✅ | ❌ | Always moved, never proxied |
| Other clonables (`ImageData`, `DOMRect`, `CryptoKey`, `FormData`, …) | ✅ | ❌ | Handed to structured clone untouched |
| Transferable host objects (`ImageBitmap`, `VideoFrame`, `AudioData`, `OffscreenCanvas`, `MediaStreamTrack`, …) | ✅ | ❌ | Copied by default, [`transfer()`](/guides/identity-and-transfer/) to move |
| `WeakMap`, `WeakSet`, other unclonables | ❌ | ❌ | |

Anything not listed can be added with a [custom revivable](/guides/custom-revivables/).

## Errors

Any of these built-in error sent across context will be preserved:\
`Error`, `TypeError`, `RangeError`, `SyntaxError`, `ReferenceError`, `EvalError`, `URIError`, `AggregateError`, `DOMException`.

If you try to use a custom `Error` subclass, it will be transformed into a plain `Error`, while keeping its fields `name`, `message`, `stack` and `cause`.

## Symbols

Sending a named `symbol` (`Symbol.for('a')`) properly keeps its name.\
Trying to send a unique `symbol` (`Symbol()`), will transmit it by using the [`identity()`](/guides/identity-and-transfer/) feature.

## Typed arrays

Trying to send a TypedArray will properly preserve its type:
`Int8Array`, `Uint8Array`, `Uint8ClampedArray`, `Int16Array`, `Uint16Array`, `Int32Array`, `Uint32Array`, `Float16Array`, `Float32Array`, `Float64Array`, `BigInt64Array`, `BigUint64Array`.

Note: wrapping a TypedArray in [`transfer()`](/guides/identity-and-transfer/) moves its backing `ArrayBuffer`, detaching it on the sending side.\
A view that only covers part of its buffer has that window copied out first, so only a view covering its whole buffer avoids the copy entirely.

## Blob & File

The reason why Blob and File are not supported via JSON transport is that to read them, the platform only exposes asynchronous ways to read their bytes.\
There is no easy way for osra to make a protocol that nicely wraps and expose a way to interact with asynchronous data on immutable blobs that those types requires.

If you need to transfer Blob or File values, please transform them into `ArrayBuffer` or `Uint8Array` first and wrap them back yourself:

```ts twoslash
const blob = new Blob([])
const file = new File([], 'filename.txt')
// ---cut---
blob.arrayBuffer()
file.arrayBuffer()
```

## Events

All `Event` types are transmitted as a generic `Event` with the exception of `CustomEvent`, any other subclasses are dropped. This means that `MessageEvent` types will drop their `data` and arrive as a generic `Event` without it.

So an `Event` will carry its `type`, `bubbles`, `cancelable` and `composed` fields, and a `CustomEvent` will in addition carry the `detail` field.

If you need transmit any other fields related to your Event subclass, please extract them to be sent along with that event.

## EventTarget

The current `EventTarget` implementation is a bit crude. Right now, it acts as a minimalist `addEventListener`/`removeEventListener` proxy.

Since the transport is asynchronous by nature, any events emitted before the `.addEventListener` call is sent across the wire and registered on the source value will be missed.

In addition, calling `dispatchEvent` on the proxy EventTarget does nothing, events only flow from the source outward.

## Unclonables

Types like `WeakMap`, `WeakSet` are by designed tied to a specific context, as such, those values cannot be transmitted.
Trying to use them will throw an error at compile time.
