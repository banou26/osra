---
title: Connections
description: What a connection is, how the handshake creates one, and how to read, identify and drop each peer.
---

Everything in osra happens over connections.\
A connection is what a pair of `expose()` calls establish over a [transport](/guides/transports/): each side sends its exposed value across, each side gets the other's back, and every call, stream and promise between them rides on that connection afterwards.

`expose()` gives you back its connections in two ways: awaiting the result gives you the first one, and iterating it gives you every one as it arrives.\
Both hand back the same shape.

```ts twoslash
import { expose } from 'osra'
declare const worker: Worker
type Api = { ping: () => string }
// ---cut---
const remote = await expose<Api>({}, { transport: worker })

for await (const remote of expose<Api>({}, { transport: worker })) {
  remote.ping()
}
```

By default that shape is the peer's exposed value, which is what `expose()` has always resolved to.\
The [`connection` option](#choosing-what-a-connection-is) changes it.

## How a connection is made

A connection begins with a handshake, and the handshake needs traffic in both directions.\
This means that the transport must be able to both emit and receive: if you pass half a transport, for example only the `emit` side of a [custom pair](/guides/custom-transports-and-relays/), `expose()` rejects immediately with an error telling you so.

Every `expose()` call generates a random uuid for itself.\
Until it has its first connection, it announces that uuid on the transport, retrying with a backoff that starts at 50ms and doubles up to once per second.\
This is what lets you `expose()` toward an iframe that has not finished loading or a worker that starts late: whoever comes up first just keeps knocking until the other side answers.

A side that hears an announce answers with an announce of its own, addressed to that uuid.\
Once the two sides know each other's uuid, each one sends a single `init` message carrying its exposed value, encoded for the wire as described in [revivables](/guides/revivables/).\
Your `expose()` promise resolves when the peer's `init` arrives and its value has been revived, so what the await hands you is ready to call.\
If nobody ever answers, the promise just stays pending; [errors and lifecycle](/guides/lifecycle/#connecting) covers the cases where it rejects instead.

One thing to note is that your own value is built and serialized as part of that `init` message, which is why a [`context()`](#a-different-value-per-peer) factory runs before anything reaches the peer.

Osra never reconnects on its own.\
Once your side has a connection it stops announcing, but it keeps listening, so a new peer that announces later on the same channel still connects to you.\
And if a connection goes away, calling `expose()` on the same transport again starts a fresh handshake, since a teardown does not poison the transport, see [errors and lifecycle](/guides/lifecycle/#closing).\
This matters mostly for WebExtension MV3 service workers, which the platform unloads on its own schedule; the [transports](/guides/transports/#webextension) page covers reconnecting there.

Also keep in mind that a transport is a channel, not a connection: several independent `expose()` calls can share one channel under different `key`s, and a single `expose()` can hold several peers at once.\
[Multiple peers](/guides/multiple-peers/) covers both shapes, including how pinning `uuid` and `remoteUuid` on both sides skips the announce phase entirely.

## Choosing what a connection is

The `connection` option receives `{ value, context }` and returns whatever a connection should mean in your code.

```ts twoslash
import { expose } from 'osra'
declare const worker: Worker
// ---cut---
const { value, context } = await expose({}, {
  transport: worker,
  connection: ({ value, context }) => ({ value, context })
})
```

Since it is a plain function, it can return anything you like, for example just the one field you care about:

```ts twoslash
import { expose } from 'osra'
declare const child: Window
// ---cut---
for await (const origin of expose({}, {
  transport: child,
  connection: ({ context }) => context.origin
})) {
  origin // string | undefined
}
```

It runs on your side, per connection, after the handshake finishes.\
It cannot change what you send, and nothing it returns ever crosses the wire.

## What is in the context

The context contains only what the transport actually observed, plus an `abort` for that one peer.\
The fields come off the inbound message, and each one appears only when the browser actually set it:

| Transport | Context |
|---|---|
| Window, iframe | `abort`, `origin`, `source` |
| WebExtension | `abort`, `port`, `sender` |
| WebSocket | `abort`, `origin` |
| MessagePort, Worker, SharedWorker | `abort` |

One thing to remember is that a port or a worker observes nothing about its peer: their messages arrive with `origin: ''` and `source: null`, so neither field survives.\
A server handing out ports therefore cannot learn who a peer is from the connection, and it does not need to, because it created that port in response to something that did know, so the identity is already in scope where you call `expose()`.

Also keep in mind that a WebSocket's `origin` is the origin of the socket's URL, not the peer's: every peer on the same relay reports the same one, which makes it useless for telling them apart.\
Identify relay peers with `key`, `name`, or something in your own payload instead.

Nothing in the context is ever sent anywhere, and nothing the peer sends can reach it.\
It is built purely from what the browser told your side about the delivery, which the peer cannot forge.

## A different value per peer

Wrap your value in `context()` and it is built once per connection, from that connection's context, instead of being one object shared by everyone.

```ts twoslash
import { expose, context } from 'osra'
declare const child: Window
declare const readFor: (origin: string | undefined) => (path: string) => string
// ---cut---
expose(context(({ origin }) => ({ read: readFor(origin) })), { transport: child })
```

The factory runs **before** your value is boxed and sent, which is what makes it useful: a server embedded by several realms can answer each one differently, rather than exposing one object to all of them.

One thing to note is that this is a wrapper rather than "just pass a function", because osra exposes functions as endpoints.\
This means that a bare function is a value you are exposing, not a factory:

```ts twoslash
import { expose } from 'osra'
declare const worker: Worker
// ---cut---
expose(async (n: number) => n * 2, { transport: worker }) // an endpoint, called by the peer
```

The factory and `connection` receive the same context object, so anything your `connection` function needs, it can derive by itself.\
Nothing has to be declared up front.

## Dropping one peer

Calling `context.abort()` closes that one connection and leaves every other peer alone.\
`unregisterSignal` is still the way to tear down your whole side, see [errors and lifecycle](/guides/lifecycle/#closing).

```ts twoslash
import { expose } from 'osra'
declare const child: Window
declare const allowed: (origin: string | undefined) => boolean
// ---cut---
for await (const peer of expose({}, {
  transport: child,
  connection: ({ value, context }) => ({ value, context })
})) {
  if (!allowed(peer.context.origin)) peer.context.abort?.()
}
```

If you call it from inside a `context()` factory instead, the peer is refused outright, before your value is ever sent, and the peer's own `expose()` rejects:

```ts twoslash
import { expose, context } from 'osra'
declare const child: Window
declare const allowed: (origin: string | undefined) => boolean
declare const resolvers: { read: (path: string) => string }
// ---cut---
expose(
  context(ctx => {
    if (!allowed(ctx.origin)) ctx.abort?.()
    return resolvers
  }),
  { transport: child }
)
```

## Every loop sees every peer

Several `for await` loops over one `expose()` result each get every connection.\
They are independent readers rather than a shared queue, which means that one loop cannot consume a peer another loop was waiting for.

Peers that connect before anything iterates are buffered, up to the 32 most recent, and that buffer is replayed to every loop that starts afterwards.\
This also bounds what a side that only ever awaits holds on to: it keeps at most those 32, no matter how many peers show up.

One thing to note is that the replay only covers peers that arrived while nothing was iterating.\
A loop that starts while another is already running does not replay what the first one already received, it gets that buffer plus every peer from the moment it starts.

## Typing it

With no `connection` option, `expose<Api>()` types the result as `Remote<Api>`, exactly as before.\
With one, the result type is inferred from whatever your function returns.

One thing to remember is that those two cannot be combined, because TypeScript has no partial type-argument inference: passing `<Api>` explicitly makes every later type parameter fall back to its default, so the inferred result type is lost.\
If you want both, type the peer on the function's parameter instead, using the `Connected` and `Remote` types osra exports:

```ts twoslash
import { expose } from 'osra'
import type { Connected, Remote } from 'osra'
declare const worker: Worker
type Api = { ping: () => string }
// ---cut---
const { value, context } = await expose({}, {
  transport: worker,
  connection: ({ value, context }: Connected<Remote<Api>>) => ({ value, context })
})

await value.ping()
```
