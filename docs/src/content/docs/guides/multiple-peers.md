---
title: Multiple peers
description: Run several connections over one channel, and scope who is allowed to answer.
---

A transport is a channel, not a connection. Several connections can share one channel, and one connection can have several peers on it.

## Several connections, one channel

Give each one a `key`. Traffic on one key is invisible to the other, so two unrelated parts of your app can share a worker without stepping on each other.

```ts twoslash
import { expose } from 'osra'
declare const worker: Worker

const analytics = { track: (event: string) => {} }
const storage = { get: (key: string) => 'value' }
// ---cut---
expose(analytics, { transport: worker, key: 'analytics' })
expose(storage, { transport: worker, key: 'storage' })
```

Both sides need the same key. The default is `'__OSRA_DEFAULT_KEY__'`, which is what you get when you leave it out.

`key` is a label, not a credential. Anyone on the channel using that key is a valid peer.

## Several peers, one connection

If more than one peer answers on the same key, they all connect. Each gets your exposed value and can call into it.

Awaiting your `expose()` gives the **first** peer's value and stays resolved on it. Iterating gives every peer instead, as each one arrives:

```ts twoslash
import { expose } from 'osra'
declare const worker: Worker
type PeerApi = { ping: () => string }
// ---cut---
for await (const peer of expose<PeerApi>({}, { transport: worker })) {
  peer.ping()
}
```

That covers broadcast (a background script exposing an API to every content script) and talking to peers individually, since each iteration is one peer. To learn who each one is, or to drop one, use `connection`. See [connections](/guides/connections/).

The other shape is one connection per peer, which you get for free when the platform hands you a port each time:

```ts twoslash title="shared-worker.ts"
import { expose } from 'osra'

const api = { add: (a: number, b: number) => a + b }

globalThis.addEventListener('connect', event => {
  for (const port of (event as MessageEvent).ports) {
    expose(api, { transport: port })
  }
})
```

Every page gets its own port, its own connection and its own `expose()`. The same pattern applies to `runtime.onConnect` in an extension.

Worth knowing which of the two you want: a port observes nothing about its peer, so a per-port `expose()` learns identity from the scope that created the port. One `expose()` with several peers on a window transport observes each peer's `origin` directly.

## Naming the ends

`name` labels your side. `remoteName` says which label you accept, and messages from anyone else are dropped.

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

Useful when several peers share a key and you want a specific one, and generally clearer in logs than a random uuid.

## uuid and remoteUuid

Every instance gets a random `uuid` at startup and announces itself with it. That is how osra tells peers apart, and how it ignores its own messages when a channel echoes them back.

You can pin them. Set `uuid` to a fixed value and preset the peer's as `remoteUuid`, and the handshake is skipped: init goes out immediately, once.

```ts
// side A
expose(a, { transport, uuid: A, remoteUuid: B })
// side B
expose(b, { transport, uuid: B, remoteUuid: A })
```

Do this on both sides or not at all. A side that preset `remoteUuid` never announces, so a peer waiting for an announce waits forever.

It also gives up the retry loop that makes the normal handshake tolerant of a slow start. The peer has to be listening already. Unless you have a reason, let osra announce.

## Scoping a connection

Four options decide who your side talks to, and they compose:

| Option | Scope |
|---|---|
| `key` | Which logical channel you are on. |
| `origin` | Which origin may send and receive, on window transports. Applied in both directions. |
| `remoteName` | Which peer label you accept. |
| `remoteUuid` | Which exact instance you accept. |

`origin` is the one that matters across documents, since it is enforced by the browser rather than by osra. Set it whenever the two sides are on different origins. See [transports](/guides/transports/#iframe) for how it applies, including the one announce message that has to go out with `'*'`.

The rest are routing labels. They keep independent connections from colliding, and they keep the wrong peer's traffic out of your handlers, but they are values on the wire that any peer on the channel can set. If a channel is reachable by code you do not control, scope it with `origin`, or do not put it on a shared channel at all.
