---
title: identity() and transfer()
description: Keep a reference stable across a connection with identity(), or move a value instead of copying it with transfer().
---

Osra comes with two small helpers that change how a value crosses a connection:

- `identity(value)` keeps the value's reference stable, so the other side sees one object for it no matter how many times you send it.
- `transfer(value)` moves the value instead of copying it, which is a lot cheaper for large buffers.

Both of them give you back the exact value you passed in, with the same type, so you can drop them into an existing call without changing any signature.\
Both are also no-ops on values they don't apply to, wrapping a string in either of them does nothing.

## identity()

By default, every send is a copy.\
If you send the same object twice, the other side ends up with two unrelated copies of it.

Wrapping the value in `identity()` once ties it to its reference instead.\
From then on, the other side sees a single object for it, on every send:

```ts twoslash title="worker.ts"
import { expose, identity } from 'osra'

const plain = { foo: 'bar' }
const shared = { foo: 'bar' }
const payload = { plain1: plain, plain2: plain, ref1: identity(shared), ref2: shared }
export type Payload = typeof payload

expose(payload, { transport: globalThis })
```

```ts twoslash title="main.ts"
// @filename: worker.ts
import { expose, identity } from 'osra'
const plain = { foo: 'bar' }
const shared = { foo: 'bar' }
const payload = { plain1: plain, plain2: plain, ref1: identity(shared), ref2: shared }
export type Payload = typeof payload
expose(payload, { transport: globalThis })
// @filename: main.ts
declare const worker: Worker
// ---cut---
import type { Payload } from './worker'
import { expose } from 'osra'

const { plain1, plain2, ref1, ref2 } = await expose<Payload>({}, { transport: worker })

plain1 === plain2 // false, the same object in two places arrives as two copies
ref1 === ref2 // true, one object, and marking it once was enough
```

One thing to note is that `ref2` was sent without any wrapper.\
The mark lives on the value, not on that one send, so every later send of it resolves to the same object on the other side.

### Sending it back

Since the mark travels with the value, the peer doesn't have to do anything to hand it back.\
Whatever you gave out, you get back as your actual original object:

```ts twoslash
import { expose, identity } from 'osra'

const settings = { theme: 'dark' }

expose({
  getSettings: () => identity(settings),
  saveSettings: (saved: typeof settings) => {
    saved === settings // true, the peer just sent back what it was given
  }
}, { transport: globalThis })
```

This is what makes remote callbacks removable: `removeEventListener` needs the exact function that was registered, and osra's own [`EventTarget`](/guides/supported-types/#eventtarget) proxy uses `identity()` for exactly that.

Keep in mind that what travels is the reference, not the contents.\
The peer's copy is still its own object, so a change made on one side is not synced to the other.

### Down a chain of contexts

An identity keeps working however far the value travels.\
A context that received one can pass it on to the next, and whatever comes back resolves at each hop to exactly the value that hop handed out, all the way to the origin:

```ts twoslash title="page.ts"
import { expose, identity } from 'osra'
declare const worker: Worker
// ---cut---
const session = { user: 'ada' }

expose({
  getSession: async () => identity(session),
  close: async (returned: typeof session) => {
    returned === session // true, however many contexts it went through
  }
}, { transport: worker })
```

```ts twoslash title="worker.ts"
import { expose } from 'osra'
declare const child: Worker
type Page = {
  getSession: () => Promise<{ user: string }>
  close: (session: { user: string }) => Promise<void>
}
// ---cut---
// the middle context forwards both ways and marks nothing itself
const page = await expose<Page>({}, { transport: globalThis })

expose({
  getSession: async () => page.getSession(),
  close: async (session: { user: string }) => page.close(session),
}, { transport: child })
```

```ts twoslash title="child.ts"
import { expose } from 'osra'
type Middle = {
  getSession: () => Promise<{ user: string }>
  close: (session: { user: string }) => Promise<void>
}
// ---cut---
const middle = await expose<Middle>({}, { transport: globalThis })

const session = await middle.getSession()
await middle.close(session)
```

Sending it costs the full payload the first time a given peer sees it, and only a small reference on every send after that.

One thing to note is that the value comes home the way it went out.\
Each context resolves identities per peer, so if the same value reaches a context through two different routes, that context ends up with two different references, each tied to whoever sent it.

### Lifetime

Each side only holds on to the peer's identities for as long as the original value is alive.\
When your value gets garbage collected, osra tells the peer to drop its copy, and a peer that had passed it further along tells its own peer in turn, so a chain unwinds from the origin outward.

A few small things worth knowing:

- Primitives pass through `identity()` untouched, there is no reference to keep.
- Marking the same value twice does nothing extra.
- Unique symbols (`Symbol()`) ride this machinery automatically, which is why they keep their identity across a connection without you wrapping anything, see [supported types](/guides/supported-types/#symbols).

## transfer()

Osra copies transferable values by default, just like `postMessage()` does when you don't give it a transfer list.\
Wrapping a value in `transfer()` moves it instead, which is the difference between duplicating 16 MB of pixels and handing over a pointer:

```ts twoslash
import { transfer } from 'osra'
declare const render: (pixels: ArrayBuffer) => Promise<void>
// ---cut---
const pixels = new ArrayBuffer(16_000_000)

await render(transfer(pixels))

pixels.byteLength // 0, it now belongs to the peer
```

[Transfer semantics](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects) are the platform's: the moment the value ships, it is detached on your side, and reading it afterwards is an error.\
There is only ever one owner.

Here is what wrapping each kind of value does on a structured transport:

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

Anything else passes through `transfer()` unchanged, so wrapping a plain object is harmless, and wrapping the same value twice does nothing extra.

Keep in mind that a [custom transport](/guides/custom-transports-and-relays/#transferables) only moves values when its `emit` forwards the transferables list.\
Otherwise everything falls back to a copy.

### Typed arrays and DataView

A typed array that spans its whole buffer moves that buffer, detaching it on your side.\
A view over part of a buffer only ever ships the bytes it can see, so that window is sliced out first and the slice is what moves, leaving your buffer intact:

```ts
transfer(new Uint8Array(buffer))          // moves, buffer is detached
transfer(new Uint8Array(buffer, 8, 4))    // ships those 4 bytes, buffer is fine
```

`DataView` is the exception: wrapping one always moves its entire backing buffer, even when the view only covers part of it.\
The view arrives with its window intact over the moved buffer, and the whole buffer is detached on your side.

### Streams

A `ReadableStream` or a `WritableStream` is always proxied chunk by chunk, the stream itself never moves.\
Wrapping one in `transfer()` keeps that proxying exactly as it is, and moves every transferable found inside each chunk instead of copying it.\
The same goes for the body of a wrapped `Request` or `Response`.

The details, including per-chunk wrapping and the detach caveats, are in [revivables](/guides/revivables/#readablestream).

### Values that always move

Some host objects cannot be copied by structured clone at all, so on a structured transport they move whether you wrapped them or not:\
`MessagePort`, `TransformStream`, `OffscreenCanvas`, `MediaStreamTrack`, `MediaSourceHandle`, `MIDIAccess`, `RTCDataChannel`, `WebTransportSendStream`, `WebTransportReceiveStream`.

This means that sending one of these detaches it on your side, every time.

`SharedArrayBuffer` is the opposite case: it is neither copied nor moved, both contexts simply look at the same memory.

### JSON transports

A JSON transport cannot move anything, there is no memory to hand over in a text protocol.\
On those, `transfer()` quietly degrades to a copy: same code, no error.

Most of the values in the table above are not available on JSON transports at all, see the [supported types](/guides/supported-types/) table.\
`MessagePort` still works there because osra proxies it instead of moving it.
