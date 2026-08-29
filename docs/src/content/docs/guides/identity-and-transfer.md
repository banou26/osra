---
title: identity() and transfer()
description: Keep a reference stable across a connection with identity(), or move a value instead of copying it with transfer().
---

Osra comes with two small wrapper functions that change how a value crosses a connection: `identity()` keeps a reference stable, and `transfer()` moves a value instead of copying it.\
Both of them are no-ops on values they do not apply to, and both lie a little at the type level: `identity(x)` and `transfer(x)` have the same type as `x`, so they slot into your existing signatures without changing anything.

## identity()

By default, every send is a copy.\
This means that if you send the same object twice, the other side ends up with two unrelated objects.

Wrapping the value in `identity(value)` pins it to a reference instead.\
The other side sees a single object no matter how many times you send it, and it stays that same object on every later send.

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

Sending a revived value back to where it came from gives its origin a fresh copy, just like any other send.\
If you wrap it in `identity()` again, the origin gets its actual original object back:

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

This is what makes remote callbacks removable: `removeEventListener` needs the exact function reference that was registered, and osra's own [`EventTarget`](/guides/supported-types/#eventtarget) façade uses `identity()` internally for exactly that.

### Lifetime and cleanup

Primitives pass through `identity()` untouched, since there is no reference to keep.\
Wrapping the same value twice does nothing extra either, you get the exact same wrapper back.

One thing to note is that each side only holds on to the other's identities for as long as the original value is alive.\
When your value gets garbage collected, osra tells the peer to drop its cached copy.

Note: unique symbols (`Symbol()`) ride this machinery automatically, which is why they keep their identity across a connection without you wrapping anything, as covered in [supported types](/guides/supported-types/#symbols).

## transfer()

Osra copies transferable values by default, just like calling `postMessage()` without a transfer list.\
Wrapping the value in `transfer(value)` moves it instead, which is the difference between duplicating 16 MB of pixels and handing over a pointer.

```ts twoslash
import { transfer } from 'osra'
declare const render: (pixels: ArrayBuffer) => Promise<void>
// ---cut---
const pixels = new ArrayBuffer(16_000_000)

await render(transfer(pixels))

pixels.byteLength // 0, it now belongs to the peer
```

[Transfer semantics](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects) are the platform's, so the value is detached on your side once it ships.\
Trying to read it afterwards is an error, and that is the point: there is only ever one owner.

The following table summarizes what wrapping each kind of value does on a structured transport:

| Value | Default | Wrapped in `transfer()` |
|---|---|---|
| `ArrayBuffer` | copied | moved |
| Typed array spanning its whole buffer | copied | backing buffer moved |
| Typed array over part of its buffer | its window copied | its window sliced out and moved, buffer intact |
| `DataView` | copied | whole backing buffer moved |
| `ImageBitmap`, `VideoFrame`, `AudioData` | copied | moved |
| `ReadableStream`, `WritableStream` | proxied, chunk contents copied | proxied, chunk contents moved |
| `Request`, `Response` | body proxied, chunk contents copied | body proxied, chunk contents moved |
| `MessagePort`, `TransformStream`, `OffscreenCanvas` | moved anyway | moved anyway |
| `SharedArrayBuffer` | shared | shared, see below |

Anything else passes through `transfer()` unchanged, so wrapping a plain object is harmless rather than an error, and wrapping the same value twice does nothing extra.\
Also keep in mind that a [custom transport](/guides/custom-transports-and-relays/#transferables) only moves values when its `emit` forwards the transferables list, otherwise everything falls back to a copy.

### Typed arrays and DataView

A typed array that spans its whole buffer moves that backing `ArrayBuffer`, detaching it on your side.\
A view that only covers part of its buffer only ever ships the bytes it can see, so its window is sliced out first and the slice is what moves, leaving your original buffer intact.

```ts
transfer(new Uint8Array(buffer))          // moves, buffer is detached
transfer(new Uint8Array(buffer, 8, 4))    // ships those 4 bytes, buffer is fine
```

`DataView` behaves differently: since 0.6.6, wrapping one moves its backing buffer, and it always moves the entire buffer, even when the view only covers part of it.\
The view arrives on the other side with its window intact over the moved buffer, and the whole buffer is detached on yours.

### Streams

`ReadableStream` and `WritableStream` are always [proxied chunk by chunk](/guides/revivables/#readablestream), the stream itself is never moved.\
Wrapping one in `transfer()` keeps that proxying exactly as it is, and instead moves every transferable found inside each chunk rather than copying it.

Wrapping a `Request` or `Response` does the same thing for its body stream.\
The details, including per-chunk wrapping and the detach caveats, are covered in [revivables](/guides/revivables/#readablestream).

### Values that always move

Some host objects cannot be copied by structured clone at all, so on a structured transport they are moved whether you wrapped them or not:\
`MessagePort`, `TransformStream`, `OffscreenCanvas`, `MediaStreamTrack`, `MediaSourceHandle`, `MIDIAccess`, `RTCDataChannel`, `WebTransportSendStream`, `WebTransportReceiveStream`.

This means that sending one of these detaches it locally, every time.

`SharedArrayBuffer` is the opposite case: it is neither copied nor moved, both contexts simply end up looking at the same memory.

### JSON transports

A JSON transport cannot move anything, because there is no ownership to hand over in a text protocol.\
On those, `transfer()` quietly degrades back to a copy: same code, no error.

One thing to note is that most of the values in the table above are not available on JSON transports at all, see the [supported types](/guides/supported-types/) table.\
`MessagePort` still works there because osra proxies it instead of moving it.
