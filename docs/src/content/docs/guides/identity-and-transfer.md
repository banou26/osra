---
title: identity() and transfer()
description: Keep a reference stable across a connection, or move a buffer instead of copying it.
---

Two small wrappers that change how a value crosses. Both are no-ops on values they do not apply to, and both lie a little at the type level: `identity(x)` and `transfer(x)` have the same type as `x`, so they slot in anywhere.

## identity()

By default every send is a copy. Send the same object twice and the peer gets two unrelated objects.

`identity(value)` pins it to a reference instead. The peer sees one object however many times you send it, and it stays the same object on later sends.

```ts twoslash title="worker.ts"
import { expose, identity } from 'osra'

const value = { foo: 'bar' }
const payload = { value, ref1: identity(value), ref2: identity(value) }
export type Payload = typeof payload

expose(payload, { transport: globalThis })
```

```ts twoslash title="main.ts"
// @filename: worker.ts
import { expose, identity } from 'osra'
const value = { foo: 'bar' }
const payload = { value, ref1: identity(value), ref2: identity(value) }
export type Payload = typeof payload
expose(payload, { transport: globalThis })
// @filename: main.ts
declare const worker: Worker
// ---cut---
import type { Payload } from './worker'
import { expose } from 'osra'

const { value, ref1, ref2 } = await expose<Payload>({}, { transport: worker })

value === ref1 // false, one is a copy
ref1 === ref2 // true, same reference
```

### The return trip

Sending a revived value back gives its origin a fresh copy, like any other send. Wrap it in `identity()` again and the origin gets its actual original object back:

```ts twoslash
import { expose, identity } from 'osra'

const settings = { theme: 'dark' }

expose({
  getSettings: () => identity(settings),
  saveSettings: (saved: typeof settings) => {
    saved === settings // true, only when the peer sent it back wrapped
  }
}, { transport: globalThis })
```

This is what makes remote callbacks removable: `removeEventListener` needs the same function reference the source registered, and osra's own [`EventTarget`](/guides/supported-types/#eventtarget) façade uses `identity()` internally for exactly that.

### Housekeeping

Primitives pass through untouched, since there is no reference to keep. Wrapping twice does nothing extra.

Each side holds the other's identities only for as long as the original is alive. When your value is garbage collected, osra tells the peer to drop its copy.

Non-registry symbols go through this automatically, which is why `Symbol()` keeps its identity across a connection without you doing anything.

## transfer()

osra copies transferable values by default. `transfer(value)` moves them instead, which is the difference between duplicating 16 MB and handing over a pointer.

```ts twoslash
import { transfer } from 'osra'
declare const render: (pixels: ArrayBuffer) => Promise<void>
// ---cut---
const pixels = new ArrayBuffer(16_000_000)

await render(transfer(pixels))

pixels.byteLength // 0, it now belongs to the peer
```

[Transfer semantics](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects) are the platform's, so the value is detached on your side afterwards. Reading it is an error, which is the point: there is only ever one owner.

Works on `ArrayBuffer` and its views, `MessagePort`, `ImageBitmap`, `OffscreenCanvas`, `VideoFrame`, `AudioData` and `TransformStream`. Anything else passes through unchanged, so wrapping a plain object is harmless rather than an error.

### What it does not do

**Partial views get copied.** A view over part of a buffer only ships the bytes it can see, so there is nothing to detach and your buffer stays intact. Only a view spanning its whole buffer actually moves.

```ts
transfer(new Uint8Array(buffer))          // moves, buffer is detached
transfer(new Uint8Array(buffer, 8, 4))    // copies those 4 bytes, buffer is fine
```

**Streams are proxied, not moved, but wrapping one moves its chunks.** `ReadableStream` and `WritableStream` always cross chunk by chunk; `transfer(stream)` keeps that proxying and moves every transferable inside each chunk instead of copying it. See [revivables](/guides/revivables/#readablestream).

**JSON transports cannot move anything.** There is no ownership to hand over in a text protocol, so `transfer()` quietly falls back to a copy. Same code, no error.

### Values that always move

Some host objects cannot be copied at all, so they are moved whether or not you ask: `MessagePort`, `TransformStream`, `OffscreenCanvas`, `MediaStreamTrack`, `RTCDataChannel`, `MIDIAccess`. Sending one detaches it locally, every time.

`SharedArrayBuffer` is the opposite case. It is neither copied nor moved, both contexts end up looking at the same memory.
