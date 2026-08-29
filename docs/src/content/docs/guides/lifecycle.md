---
title: Errors and lifecycle
description: How errors cross a connection, when expose() resolves or rejects, and what happens to everything in flight when a connection goes away.
---

Osra connections are long lived, and so are the calls, streams and promises riding on them.\
This page covers the life of a connection around its happy path: how a throw on one side reaches the other, what `expose()` does while it is still looking for a peer, and what happens to everything in flight the moment a connection goes away.

## Errors travel

If the far side throws while handling one of your calls, your pending promise rejects with the error itself, not a stringified description of it.\
The thrown value goes through the same treatment as any other value, so you catch a real `Error` carrying the original `message`, the far side's `stack`, and any `cause` chain it had.\
This also means that throwing something that is not an `Error` works, the caller simply catches whatever value was thrown.

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

Any of these built-in error classes will arrive as an instance of the same class:\
`Error`, `TypeError`, `RangeError`, `SyntaxError`, `ReferenceError`, `EvalError`, `URIError`, `AggregateError`, `DOMException`.\
An `AggregateError` keeps its `errors` array, with each inner error going through this same treatment, and a `DOMException` keeps its `name` and `message`.

If you try to throw a custom `Error` subclass, it will arrive as a plain `Error` that keeps its `name`, `message`, `stack` and `cause`.\
This means that `instanceof MyCustomError` will be `false` on the other side, so compare on `error.name` instead.\
More details in [supported types](/guides/supported-types/#errors).

## Connecting

`expose()` resolves once the two sides have found each other.\
Until then, it keeps announcing itself on the transport, backing off from 50ms up to once a second, and stops announcing as soon as a peer connects.\
This is what lets you expose to an iframe that has not finished loading yet, or to a worker that starts late: whenever the other side shows up, the next announce completes the handshake.

One thing to note is that if there is genuinely nobody on the other end, `expose()` stays pending forever.\
This is deliberate, since a peer that shows up ten seconds later still connects.\
If you need a deadline, race it against a timeout yourself.

It does reject when the connection can never happen:

- the transport cannot both emit and receive
- your own value cannot be sent, a circular structure for example
- the peer's first message is malformed
- the peer closes before the handshake finishes, or refuses you outright
- your `unregisterSignal` aborts, in which case it rejects with your abort reason

## Closing

To tear your side down, pass an `AbortSignal` as the `unregisterSignal` option and abort it whenever you are done.

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

Aborting does four things at once: it stops listening on the transport, it tells every connected peer that the connection is over, it rejects all of your own pending calls with `Error('osra: connection closed')`, and it rejects the `expose()` promise with your abort reason if it had not resolved yet.\
If you were iterating over connections with a `for await` loop, that loop ends too.

The peer that receives the close notice runs the same teardown on its side, so pending calls reject on **both** ends rather than hanging.\
Streams whose channel routes through the connection itself, which is every stream on a JSON transport, get cancelled or errored with that same `connection closed` error, and their pending writes reject; on a structured transport a stream already in flight keeps working, see [what survives a close](#what-survives-a-close).\
If you try to call a revived function after the connection closed, it will reject immediately with that same error, without ever touching the transport.

Also keep in mind that a signal that is already aborted when you call `expose()` short-circuits: nothing gets registered on the transport and the promise rejects immediately with the abort reason.

Note: aborting does not poison the transport itself. Calling `expose()` on it again starts a completely fresh handshake.

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

The dropped peer sees the exact same close it would see from a full teardown, so its pending calls reject rather than hang, while every other peer stays connected.\
More details in [connections](/guides/connections/#dropping-one-peer).

## What survives a close

On a structured transport, [revivables](/guides/revivables/) like promises and streams ride real `MessagePort`s that are transferred through the transport, and once such a port has crossed, it is independent of the osra connection that carried it.\
This means that a promise or a stream that was already on its way keeps working after the connection closes.\
Function calls are the exception: their channel always routes through the connection itself, on every transport, so they always reject on teardown.

On a JSON transport there are no real ports to transfer, everything is routed through the connection itself, so everything dies with it.

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
