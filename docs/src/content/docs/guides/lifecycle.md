---
title: Errors and lifecycle
description: How errors cross a connection, when expose() resolves or rejects, and what happens to everything in flight when a connection goes away.
---

Osra connections are long lived, and so are the calls, streams and promises riding on them.\
This page covers what happens around the happy path: how a throw on one side reaches the other, what `expose()` does while it's still looking for a peer, and what becomes of everything in flight when a connection goes away.

## Errors

If the other side throws while handling one of your calls, your pending promise rejects with that error.\
The thrown value goes through the same treatment as any other value, so you catch a real `Error` carrying the original `message`, the other side's `stack`, and its `cause` if it had one.

```ts twoslash title="worker.ts"
import { expose } from 'osra'
// ---cut---
const payload = {
  parse: (input: string) => {
    if (input !== 'valid') throw new TypeError(`could not parse "${input}"`)
    return { ok: true }
  }
}

expose(payload, { transport: globalThis })
```

```ts twoslash title="main.ts"
// @filename: worker.ts
const payload = {
  parse: (input: string) => {
    if (input !== 'valid') throw new TypeError(`could not parse "${input}"`)
    return { ok: true }
  }
}
export type Payload = typeof payload
// @filename: main.ts
declare const worker: Worker
import type { Payload } from './worker'
import { expose } from 'osra'
// ---cut---
const { parse } = await expose<Payload>({}, { transport: worker })

try {
  await parse('nope')
} catch (error) {
  if (error instanceof TypeError) {
    error.message // could not parse "nope"
    error.stack // the worker's stack, not yours
  }
}
```

Built-in error classes arrive as an instance of the same class, which is why `instanceof TypeError` works above.\
A custom `Error` subclass arrives as a plain `Error` that keeps its `name`, `message`, `stack` and `cause`, so compare on `error.name` instead of `instanceof`.\
The full list is in [supported types](/guides/supported-types/#errors).

Throwing something that isn't an `Error` works too, the caller simply catches whatever value was thrown.

## Connecting

`expose()` resolves once the two sides have found each other.\
Until then, it keeps announcing itself on the transport, backing off from 50ms up to once a second, and stops as soon as a peer connects.

This is what lets you `expose()` toward an iframe that hasn't finished loading, or a worker that starts late: whenever the other side shows up, the next announce completes the handshake.

If there is genuinely nobody on the other end, `expose()` stays pending forever.\
This is deliberate, a peer that shows up ten seconds later still connects.\
If you need a deadline, abort your `unregisterSignal` once it passes:

```ts twoslash
import { expose } from 'osra'
declare const worker: Worker
type Api = { ping: () => string }
// ---cut---
const controller = new AbortController()
const timer = setTimeout(() => controller.abort(new Error('no peer after 5s')), 5000)

const remote = await expose<Api>({}, {
  transport: worker,
  unregisterSignal: controller.signal
})

clearTimeout(timer)
```

If the peer connects in time, clearing the timer keeps the connection alive.\
Otherwise the abort rejects `expose()` with the error you aborted with.

`expose()` also rejects right away when a connection can never happen:

- the transport cannot both emit and receive
- your own value cannot be sent, a circular structure for example
- the peer's value cannot be revived on your side
- the peer closes before the handshake finishes, or refuses you
- your `unregisterSignal` aborts, in which case it rejects with your abort reason

## Closing

To tear your side down, pass an `AbortSignal` as the `unregisterSignal` option and abort it whenever you are done:

```ts twoslash
import { expose } from 'osra'
declare const worker: Worker
type Api = { slowCall: () => Promise<string> }
// ---cut---
const controller = new AbortController()

const remote = await expose<Api>({}, {
  transport: worker,
  unregisterSignal: controller.signal
})

const pending = remote.slowCall()

controller.abort(new Error('shutting down'))

// pending rejects with Error('osra: connection closed')
```

Aborting does everything at once:

- it stops listening on the transport
- it tells every connected peer that the connection is over
- it rejects all of your pending calls with `Error('osra: connection closed')`
- it rejects the `expose()` promise with your abort reason, if it hadn't resolved yet
- it ends any `for await` loop you had running over the connections

The peer that receives the close runs the same teardown on its side, so pending calls reject on **both** ends instead of hanging.\
Calling a revived function after the connection closed rejects immediately with that same error, without ever touching the transport.

A signal that is already aborted when you call `expose()` short-circuits: nothing gets registered on the transport and the promise rejects immediately with the abort reason.

Note: aborting does not poison the transport.\
Calling `expose()` on it again starts a completely fresh handshake.

## Closing one peer

`unregisterSignal` ends your whole side at once.\
If you are serving [multiple peers](/guides/multiple-peers/) over one transport and only want to drop one of them, call `abort()` on that connection's context instead:

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

The dropped peer sees exactly the same close it would see from a full teardown, so its pending calls reject rather than hang, while every other peer stays connected.\
More in [connections](/guides/connections/#dropping-one-peer).

## What survives a close

On a structured transport, [revivables](/guides/revivables/) like promises and streams ride real `MessagePort`s that are transferred through the transport.\
Once such a port has crossed, it is independent of the osra connection that carried it, so a promise or a stream that was already on its way keeps working after the connection closes.

Function calls are the exception: their channel always routes through the connection itself, on every transport, so they always reject on teardown.

On a JSON transport there are no real ports to transfer, everything is routed through the connection, so everything dies with it.\
Streams get cancelled or errored with that same `connection closed` error, and their pending writes reject.

One thing to remember is that a revived `AbortSignal` does not abort when the connection dies, so a remote signal cannot serve as a liveness check.\
If you need to observe the death of a connection, use your own `unregisterSignal`, or the rejection of a pending call.

## Errors you might see

| Message | What happened |
|---|---|
| `osra: connection closed` | Your side aborted, or the peer did. Pending calls, streams and writers all reject with this. |
| `osra: peer closed the connection` | The peer went away before the handshake finished, or refused you outright. |
| `osra: connection aborted` | You dropped a peer with `context.abort()` while your `expose()` was still waiting on it. |
| `osra: transport must be able to both emit and receive…` | You passed half a transport. Pair it with a [custom](/guides/custom-transports-and-relays/) `{ emit, receive }`. |
| `osra: cannot serialize a circular structure…` | Break the cycle, or send the shared part by reference with [`identity()`](/guides/identity-and-transfer/#identity). |
| `osra: stream exceeded its credit window` | A peer pushed more chunks than it was granted. Usually a hand-rolled implementation of the protocol. |
| `osra: a chunk failed to deserialize on this platform` | The receiving platform dropped a moved chunk, so the [stream](/guides/revivables/#readablestream) errors instead of silently missing data. |
| `osra: Blob is only supported on structured-clone transports…` | Send an `ArrayBuffer` or `Uint8Array` instead, see [supported types](/guides/supported-types/#blob--file). |
