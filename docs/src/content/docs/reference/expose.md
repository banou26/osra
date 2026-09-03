---
title: expose()
description: The full signature, every option, what you can expose, and what the returned promise resolves to.
---

```ts
expose<Peer>(value, options): Exposed<Remote<Peer>>
```

`expose()` is osra's single entry point.\
It sends your `value` to whoever connects on the transport, and gives you back the value the peer exposed.

Both sides call it, since in osra there is no client and no server, only two ends that each expose something.\
The result is both awaitable and async-iterable: awaiting it gives you the first peer, iterating over it gives you every peer as it connects, see [connections](/guides/connections/).

`Peer` is the type of the value the peer exposed.\
Osra maps it through [`Remote<T>`](/reference/typescript/) so that what you get back matches what actually arrives, every function on the peer's value becomes an async function on yours for example.\
You can leave it out on a side that only serves.

`value` is checked at compile time against [`Capable`](/reference/typescript/), the set of every type osra can send over the transport you passed, so a JSON transport rejects more than a structured one.\
If you try to expose something your transport cannot carry, you get a compile error at the call site, with the path to the offending field. See [supported types](/guides/supported-types/).

## What you can expose

Most of the time you will expose an object of functions, but `value` does not have to be one.\
Any value osra [supports](/guides/supported-types/) can be exposed directly: plain data, a `Map`, a `ReadableStream`, or a single function.\
Everything inside it is recursively searched for [revivable values](/guides/revivables/), so an object holding functions arrives as an object holding async function proxies.

Exposing a bare function makes that function itself the thing the peer gets back:

```ts twoslash title="worker.ts"
import { expose } from 'osra'
// ---cut---
const payload = (a: number, b: number) => a + b

expose(payload, { transport: globalThis })
```

```ts twoslash title="main.ts"
// @filename: worker.ts
const payload = (a: number, b: number) => a + b
export type Payload = typeof payload
// @filename: main.ts
declare const worker: Worker
import type { Payload } from './worker'
import { expose } from 'osra'
// ---cut---
const add = await expose<Payload>({}, { transport: worker })

await add(40, 2) // 42
```

Note how the main side passes an empty object as its own value.\
`expose<Payload>({}, { transport })` is how you consume without serving anything: the `{}` still goes through the handshake as your exposed value, the peer simply has nothing to call on it.

One thing to note is that a bare function is always treated as a value to expose, never as a factory.\
If you want to build a different value for each peer that connects, wrap your factory in [`context()`](/guides/connections/#a-different-value-per-peer) instead, and osra calls it once per connection with that connection's context.

## Options

| Option | Default | What it does |
|---|---|---|
| `transport` | required | The channel to communicate over. See [transports](/guides/transports/) and [custom transports](/guides/custom-transports-and-relays/). |
| `key` | `'__OSRA_DEFAULT_KEY__'` | The logical channel this connection lives on, both sides need the same one. See [multiple peers](/guides/multiple-peers/). |
| `origin` | `'*'` | On window transports, the origin allowed in both directions. |
| `name` | | A label for your side, carried on every message you send. |
| `remoteName` | | Only accept messages from a peer with this `name`. |
| `unregisterSignal` | | An `AbortSignal` that tears your whole side down when aborted. See [errors and lifecycle](/guides/lifecycle/). |
| `uuid` | random | Pin this instance's id instead of generating one. |
| `remoteUuid` | | Pin the peer's id and skip the handshake. See [multiple peers](/guides/multiple-peers/#uuid-and-remoteuuid). |
| `revivableModules` | defaults | A `defaults => modules` function to add or replace revivable types. See [custom revivables](/guides/custom-revivables/). |
| `connection` | `({ value }) => value` | Decides what one connection resolves to, for the await and the iteration alike. See [connections](/guides/connections/). |

A few of these deserve more detail than the table can carry.

`origin` sets the `targetOrigin` of every outgoing `postMessage()` and filters incoming messages by their `event.origin`, so it covers both directions at once.\
One thing to note is that the initial announce is always broadcast with `'*'`, because a cross-origin iframe that hasn't finished loading still holds its initial `about:blank` document, and a strict `targetOrigin` would fail the browser's delivery check.\
Everything after that first contact uses the origin you configured.

`name` and `remoteName` are routing labels: `name` rides along on every message your side sends, and setting `remoteName` makes your side drop every message whose `name` does not match.\
Keep in mind that they are plain values on the wire, not credentials, so anyone on the channel can set them. See [multiple peers](/guides/multiple-peers/) for how the scoping options compose.

`unregisterSignal` is the whole-side teardown: aborting it stops listening on the transport, notifies every connected peer, rejects your pending calls, and rejects the returned promise with the abort reason if it hadn't resolved yet.\
If the signal is already aborted when you call `expose()`, nothing is registered at all and the promise rejects immediately.\
See [errors and lifecycle](/guides/lifecycle/) for the full picture, including how to drop a single peer instead.

`uuid` and `remoteUuid` pin the instance identities on both ends and skip the announce handshake entirely, which also gives up the retry loop that makes connecting tolerant of a slow start.\
Set them on both sides or on neither, see [multiple peers](/guides/multiple-peers/#uuid-and-remoteuuid).

`revivableModules` receives osra's default module list and returns the final one, so you can add your own types, drop defaults, or reorder them.\
If you pass it, also read [custom module lists](#custom-module-lists) below, because the type system needs to be told about it separately on the reading side.

## The result

`expose()` returns a promise that is also async-iterable, typed [`Exposed<T>`](/reference/typescript/).\
Awaiting it settles once the first peer has completed the handshake, and it settles with that peer's value.

If several peers answer on the same channel, awaiting still only ever gives you the first one.\
When you expect more than one peer, iterate instead, the loop hands you every peer as it connects:

```ts twoslash
import { expose } from 'osra'
declare const worker: Worker
type Api = { ping: () => string }
// ---cut---
for await (const remote of expose<Api>({}, { transport: worker })) {
  remote.ping()
}
```

Several loops over one `expose()` are independent readers that each see every peer, so one loop cannot consume a peer another was waiting for.\
Peers that connect before anything iterates are buffered, capped at the 32 most recent, and every loop that starts later begins with that backlog before receiving new peers.

Pass the `connection` option to change what a peer resolves to.\
It receives `{ value, context }` and whatever it returns becomes what the await and the iteration hand back, which is also how you reach a peer's `origin` and its `abort()`.\
It runs once per connection, on your side, after the handshake, and nothing it returns crosses the wire. See [connections](/guides/connections/).

The promise rejects when the connection can never happen:

- the transport cannot both emit and receive
- your own value cannot be sent, a circular structure for example
- the peer's value cannot be revived on your side
- the peer closes before the handshake completes
- `unregisterSignal` aborts, in which case it rejects with the abort reason

If there is simply nobody on the other end yet, it stays pending instead: osra keeps announcing itself, backing off from 50ms up to once a second, so a worker that starts late or an iframe that hasn't loaded yet still connects.\
If you need a deadline, abort your `unregisterSignal` after it, see [errors and lifecycle](/guides/lifecycle/#connecting).

One thing to note is that a side that only serves can ignore the result entirely.\
Osra attaches its own no-op rejection handler, so a fire-and-forget `expose()` never surfaces an unhandled rejection.

```ts twoslash
import { expose } from 'osra'
const api = { ping: () => 'pong' }
// ---cut---
expose(api, { transport: globalThis }) // fine, nothing to await
```

## Both directions

Since both ends expose something, both sides can pass a value and both sides can call into the other's.\
The worker below serves an API and consumes the page's at the same time:

```ts twoslash title="worker.ts"
import { expose } from 'osra'

type PageApi = { log: (line: string) => void }

const workerApi = { work: () => 42 }
export type WorkerApi = typeof workerApi

const { log } = await expose<PageApi>(workerApi, { transport: globalThis })

await log('worker ready')
```

## Custom module lists

When you extend osra with [custom revivables](/guides/custom-revivables/), passing the `revivableModules` option makes your modules run, and on a side that passes no type argument the value check learns about them from the option alone.\
On a side that names `Peer`, TypeScript has no partial type argument inference, so naming it resets every later type parameter to its default.\
This means that you need to pass the module list as the second type argument too, so the `Capable` check knows about your types there as well:

```ts
expose<PeerApi, ReturnType<typeof myModules>>(value, {
  transport,
  revivableModules: myModules
})
```
