---
title: Multiple peers
description: How several connections share one channel, how peers find each other, and which options decide who your side talks to.
---

One way to think about it is that a transport is a channel, while a connection is what osra establishes over it.\
The two are not one-to-one: several independent connections can share a single channel, and a single `expose()` can end up connected to several peers at once.\
This page covers how the handshake behaves when a channel is shared, and the options that decide who your side talks to.

## Several connections, one channel

If two unrelated parts of your app want to share the same worker, give each pair of `expose()` calls its own `key`.\
Inbound messages are filtered by key before anything else happens, which means that traffic on one key is completely invisible to the other.

```ts twoslash
import { expose } from 'osra'
declare const worker: Worker

const analytics = { track: (event: string) => {} }
const storage = { get: (key: string) => 'value' }
// ---cut---
expose(analytics, { transport: worker, key: 'analytics' })
expose(storage, { transport: worker, key: 'storage' })
```

Both sides need to use the same key. If you leave it out, you get the default key `'__OSRA_DEFAULT_KEY__'`, which is fine as long as the channel only carries one connection.

One thing to remember is that `key` is a label, not a credential: any peer on the channel that uses the same key is a valid peer.

## Several peers, one expose()

When `expose()` starts, it announces itself on the channel and keeps doing so, backing off from 50ms up to once a second, until a peer answers.\
Every instance listening on the same key answers the announces it sees, so when more than one peer is present, each answer becomes its own connection: every peer receives your exposed value and can call into it.\
If you wrapped your value in `context()`, the factory runs once per connection, so each peer can get its own value. See [connections](/guides/connections/).

Awaiting your `expose()` resolves with the **first** peer's value and stays resolved on it.\
Iterating gives every peer instead, each one as it arrives:

```ts twoslash
import { expose } from 'osra'
declare const worker: Worker
type PeerApi = { ping: () => string }
// ---cut---
for await (const peer of expose<PeerApi>({}, { transport: worker })) {
  peer.ping()
}
```

One thing to note is that your side stops announcing after its first connection, but that does not close the door: a peer that shows up later announces itself, your side answers, and it connects all the same.

To learn who each peer is, or to drop one, use the `connection` callback.\
It receives `{ value, context }`, where `value` is that peer's exposed value and `context` is what the transport observed about the peer (`origin` and `source` on window transports, `port` and `sender` on extension ones), plus an `abort()` that drops that one peer:

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

The full story of what the context contains on each transport lives in [connections](/guides/connections/).

The other shape is one connection per peer, which you get for free whenever the platform hands you a fresh port for each newcomer:

```ts twoslash title="shared-worker.ts"
import { expose } from 'osra'

const api = { add: (a: number, b: number) => a + b }

globalThis.addEventListener('connect', event => {
  for (const port of (event as MessageEvent).ports) {
    expose(api, { transport: port })
  }
})
```

Every page gets its own port, its own connection and its own `expose()`. The same pattern applies to `runtime.onConnect` in a web extension.

It is worth knowing which of the two shapes you want: a port observes nothing about its peer, so a per-port `expose()` learns identity from the scope that created the port.\
One `expose()` with several peers on a window transport observes each peer's `origin` directly.

## Naming the ends

`name` labels your side, and rides along on every message you send.\
`remoteName` says which label you accept: any message carrying a different name is dropped before it reaches your connection.

```ts twoslash
import { expose } from 'osra'
declare const worker: Worker
const api = {}
type PeerApi = {}
// ---cut---
// worker side
expose(api, { transport: worker, name: 'worker', remoteName: 'page' })
```

```ts twoslash
import { expose } from 'osra'
declare const worker: Worker
const api = {}
type PeerApi = {}
// ---cut---
// page side
const remote = await expose<PeerApi>(api, { transport: worker, name: 'page', remoteName: 'worker' })
```

This is useful when several peers share a key and you only want a specific one, and a name is generally clearer in logs than a random uuid.

Note: `remoteName` matches against the peer's `name`, so a peer that did not set one is dropped too.

## uuid and remoteUuid

Every `expose()` gets a random `uuid` at startup and announces itself with it.\
That uuid is how osra tells peers apart: everything after the announce is addressed, each message names the uuid it is for, and every instance drops messages that are not addressed to it.\
It is also how osra ignores its own messages when a channel echoes them back.

This addressing is what makes broadcast-style channels work: a WebSocket relay that forwards every message to every client still behaves like a set of private pairwise connections.\
Also keep in mind that on such a relay every peer reports the same `origin`, the origin of the socket's URL, so telling relay peers apart is a job for `key`, `name`, or something in your own payload.

You can pin the uuids. Set `uuid` to a fixed value and preset the peer's as `remoteUuid`, and the handshake is skipped: your value goes out immediately, addressed to that uuid, exactly once.

```ts
// side A
expose(a, { transport, uuid: A, remoteUuid: B })
// side B
expose(b, { transport, uuid: B, remoteUuid: A })
```

Do this on both sides or not at all.\
A side that preset `remoteUuid` never announces on its own, though it still answers announces from others, so a half-pinned pair falls back to the normal handshake anyway and you gain nothing from the pin.

Also keep in mind that pinning gives up the retry loop that makes the normal handshake tolerant of a slow start.\
The init is sent once and never re-sent, so the peer has to be listening already: a peer that starts late misses the only init that will ever be sent and waits forever.\
Unless you have a reason, let osra announce.

## Scoping a connection

Four options shape who your side talks to, and they compose:

| Option | Scope |
|---|---|
| `key` | Which logical channel you are on. |
| `origin` | Which origin may send and receive, on window transports. Applied in both directions. |
| `remoteName` | Which peer label you accept. |
| `remoteUuid` | Which instance your pinned handshake is addressed to. Not a filter: peers that announce still connect. |

`origin` is the one that matters across documents, since it is enforced by the browser rather than by osra, so set it whenever the two sides live on different origins.\
It is applied in both directions, as the `targetOrigin` of everything you send and as a filter on everything you receive.\
The one exception is the unsolicited announce, which has to go out with `'*'`: until a cross-origin iframe commits its document, its window still holds the initial `about:blank` page, and a strict `targetOrigin` fails the browser's delivery check.\
That announce carries nothing but the key, the name and the uuid; your value only travels in the addressed messages that follow, which do respect `origin`. See [transports](/guides/transports/#iframe) for a worked iframe setup.

The rest are routing labels. They keep independent connections from colliding, and they keep the wrong peer's traffic out of your handlers, but they are plain values on the wire that any peer on the channel can set.\
If a channel is reachable by code you do not control, scope it with `origin`, or do not put it on a shared channel at all.
