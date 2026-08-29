---
title: Revivables
description: How functions, promises, generators, streams and abort signals behave once they cross a connection.
---

Every [structured cloneable](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm) value is either cloned or [transferred](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects), just like when calling `postMessage()` yourself.

The part that makes osra interesting is that it allows us to send many [types](/guides/supported-types/) that aren't usually transmittable, such as `Function`, `Promise`, `ReadableStream`, ect...\
Those types are what we call "revivables", and they have two categories:

- Wrappers, like `Error`, simply take the structured cloneable fields of the original value and reconstruct that same value on the other side.
- Proxies, live wrappers around the original value that try to mimic the original's behavior, needs a communication channel to link both sides.

Revivable values such as `Promise` usually rely on channels within the transport's connection to update the remote value's state.\
Another thing to note is that most values that can contain other values, such as `Array` or `Object`, are recursively deep searched for revivable values within their structure and handle them.\
This means that for example, a `Promise` that resolves with a `Function`, passed through osra, will automatically convert that original function into a revivable async function proxy on the other context.\
This page will cover some of the nuances of such revivable values in osra.

## Functions

Any function of type `<T extends any[], T2>(...args: T) => T2` will be [revived](/guides/custom-revivables/) as `<T extends any[], T2>(...args: T) => Promise<T2>`.

This means that synchronous functions are not supported, and all functions are automatically converted to async functions.

Every arguments and return values are automatically handled, as long as osra supports the type you want to use as argument or return value, it will work.\
If not, you will get a proper compile time error.

```ts twoslash title="worker.ts"
import { expose } from 'osra'
// ---cut---
type Callback = (item: number) => void
const payload = (nums: number[], cb: Callback) => nums.map(cb)

expose(payload, { transport: globalThis })
```

```ts twoslash title="main.ts"
// @filename: worker.ts
const payload = (nums: number[], cb: (item: number) => void) => nums.map(cb)
export type Payload = typeof payload
// @filename: main.ts
declare const worker: Worker
import type { Payload } from './worker'
import { expose } from 'osra'
// ---cut---
const each = await expose<Payload>({}, { transport: worker })
await each(
  [1, 2, 3],
  num => console.log(num)
)
// 1, 2, 3
```

Throwing inside the function will propagate to the other context as per [Errors and Lifecycle](/guides/lifecycle/).

One thing to remember is that, every function call creates a round trip. So if performance is a concern, consider batching calls and values together instead of making many function calls.

## Promises

Any `Promise` will settle on the other side when the original settles, rejections included.\
The resolved value goes through the same treatment as everything else, so a promise can resolve with a function, a stream, or even another promise.

## Async generators

Any async generator, or any value with a `[Symbol.asyncIterator]()` method, will be revived as an `AsyncIterableIterator`.\
Its `next`, `return` and `throw` methods are proxied just like [functions](#functions), which means that a regular `for await` loop works as expected, and breaking out of the loop early will properly run the generator's `finally` blocks in its original context.

```ts twoslash title="worker.ts"
import { expose } from 'osra'
// ---cut---
const payload = async function* () {
  yield 1
  yield 2
  yield 3
}

expose(payload, { transport: globalThis })
```

```ts twoslash title="main.ts"
// @filename: worker.ts
const payload = async function* () {
  yield 1
  yield 2
  yield 3
}
export type Payload = typeof payload
// @filename: main.ts
declare const worker: Worker
import type { Payload } from './worker'
import { expose } from 'osra'
// ---cut---
const streamData = await expose<Payload>({}, { transport: worker })

for await (const item of await streamData()) {
  console.log(item)
  if (item > 1) break // runs the generator's finally blocks in the worker
}
// 1, 2
```

One thing to be careful about is that iteration starts as soon as the value is sent, because osra calls `[Symbol.asyncIterator]()` at send time.\
A generator object returns itself from that method, so sending the same generator to two different places gives them a single shared cursor that they both advance.\
To avoid this, expose a function that creates a fresh generator on every call, like `streamData()` above, or send an async iterable whose `[Symbol.asyncIterator]()` builds a new iterator each time.

Also keep in mind that every item is a full round trip, there is no batching or readahead.\
If throughput matters, prefer a [`ReadableStream`](#readablestream), its credit window allows it to pipeline.

## ReadableStream

A `ReadableStream` is proxied chunk by chunk, the original stream is never moved.\
Unlike [async generators](#async-generators), streams pipeline: the receiving side grants the source a credit window, the source pushes chunks up to that window without waiting for individual reads, and a slow reader naturally slows the source down.

The window starts at 8 chunks and adapts between 2 and 64 to target around 4 MiB of data in flight.\
This means that streams of small chunks get a deep window while streams of large chunks keep a shallow one. Chunks whose size cannot be measured, like plain objects or `Map`s, keep the window at 8.

Two consequences worth knowing about:

- The source starts being read as soon as the stream is revived, up to that first window, even before your first `read()` call.
- Calling `cancel(reason)` on the revived stream cancels the source stream with the reason intact.

One thing to remember is that a stream locks the moment you send it, because osra calls `getReader()` at send time, even if the other side never reads.\
This means that sending the same `ReadableStream` twice will throw, and so will sending a `Request` or `Response` whose body already went out.

By default the content of each chunk is copied, just like any other value.\
If your stream carries large binary chunks, wrap the stream itself in [`transfer()`](/guides/identity-and-transfer/): the stream is still proxied exactly the same way, but every transferable found inside its chunks (buffers, typed arrays, `VideoFrame`s, and so on) is moved instead of copied.

```ts twoslash
import { transfer } from 'osra'
declare const remote: { upload: (stream: ReadableStream<Uint8Array>) => Promise<void> }
declare const stream: ReadableStream<Uint8Array>
// ---cut---
await remote.upload(transfer(stream))
```

This works anywhere the stream crosses: as an argument, a return value, nested inside an object, or as the body of a `transfer()`red `Request` or `Response`.\
It even propagates: a chunk that contains another stream will have that stream's chunks moved too.

If you only want specific chunks moved, you can instead wrap individual chunks in `transfer()` when enqueuing them.\
Note that this per-chunk form only works when the chunk itself is a transferable (a buffer, a typed array): a plain object containing one passes through `transfer()` unchanged, so container chunks need the stream-level wrapper above.

Keep in mind that a moved buffer is detached on the sending side the moment its chunk ships, so don't reuse chunks you sent this way.\
A buffer that cannot be detached, like a `WebAssembly.Memory`'s, will error the stream when moved, just like transferring it directly would.\
And if the receiving platform fails to deserialize a moved chunk (a current Firefox issue with transferred `VideoFrame`s), the stream errors loudly rather than silently missing a chunk.\
On JSON transports the wrapper degrades back to a copy, since the bytes are base64 encoded anyway.

## WritableStream

A `WritableStream` is proxied in the other direction, one operation at a time.\
Each `write()` only resolves once the sink on the other side acknowledged it, so the remote backpressure becomes your backpressure, at the cost of one round trip per write.

Just like `ReadableStream`, a writable locks the moment you send it, since osra calls `getWriter()` at send time.\
And sending it wrapped in [`transfer()`](#readablestream) works here too, moving the buffers of every chunk the other side writes into it.

If the sink throws, your pending `write()` rejects with a plain `Error` carrying the original message.\
The error's class and any extra properties do not cross.

## AbortSignal

An `AbortSignal` is revived as the signal of a fresh `AbortController` on the other side.\
Aborting the source propagates to the revived signal, and the abort reason goes through the same treatment as any other value.

A signal that was already aborted when sent revives already aborted, synchronously.\
Otherwise the abort travels as a message, which means that the revived signal will still read `aborted === false` for a short moment after the source aborted.

One thing to note is that a connection teardown does not abort revived signals, so a remote signal cannot be used as a liveness check.\
Use the `unregisterSignal` option or the rejection of your pending calls instead, see [errors and lifecycle](/guides/lifecycle/).

## Making it fast

Since every proxy works by exchanging messages, the cost model to keep in mind is the round trip:

- **Batch your calls.** One call returning 1000 rows is one round trip, 1000 calls are 1000 round trips.
- **Prefer streams over generators** for high volume data, the credit window lets them pipeline.
- **Prefer a structured transport over JSON** when you have the choice, JSON transports base64 encode binary data.
- **[`transfer()`](/guides/identity-and-transfer/) large buffers** to move them instead of copying them, and [`transfer(stream)`](#readablestream) to do the same for every chunk.
- **Send data as data.** A `Map` with 10000 entries is a single message, not 10000 function calls.
