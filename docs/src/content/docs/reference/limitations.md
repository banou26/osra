---
title: Limitations
description: What osra cannot hide about the boundary between two contexts, and what to do about it.
---

Osra tries hard to make a value from another context feel like a local one, but a message boundary can never be hidden completely.\
This page collects the places where it stays visible, with the workaround where there is one.\
Some of them are caught by [the type system](/reference/typescript/#the-capable-check) before your code ever runs, the others you will meet at runtime, so it is worth reading through the list once.

## Calls

The most fundamental limitation is that a call has to cross the message boundary, which means that synchronous return values are impossible.\
Every function arrives on the other side as an async function: the `() => number` you expose is a `() => Promise<number>` for your peer, and there is no option to change that.

```ts twoslash title="worker.ts"
import { expose } from 'osra'
// ---cut---
const payload = { random: () => Math.random() }

expose(payload, { transport: globalThis })
```

```ts twoslash title="main.ts"
// @filename: worker.ts
const payload = { random: () => Math.random() }
export type Payload = typeof payload
// @filename: main.ts
declare const worker: Worker
import type { Payload } from './worker'
import { expose } from 'osra'
// ---cut---
const { random } = await expose<Payload>({}, { transport: worker })

await random() // a number, one round trip later
```

This also means that every call is a full round trip, two messages, the call and its result.\
That is cheap, but not free: a loop calling a remote function ten thousand times sends twenty thousand messages.\
If performance is a concern, expose a function that takes the whole batch and send data as data, see [making it fast](/guides/revivables/#making-it-fast).

One thing to note is that generic functions lose their generics along the way: a `<T>(x: T) => T` collapses to its constraint on the other side.\
Expose a concrete signature per type you care about, or accept the widening.

Also keep in mind that streams and generators are single use, because osra calls `getReader()` and `[Symbol.asyncIterator]()` at send time.\
If you try to send the same `ReadableStream` twice it will throw, and so will a `Request` or `Response` whose body already went out, while a generator sent to two peers hands them a single shared cursor that they both advance.\
Expose a function that makes a fresh one per call, as shown in [revivables](/guides/revivables/#async-generators).

## Values

Most values cross intact, but a few arrive with something missing:

| You send | The peer gets |
|---|---|
| A class instance | Its own data properties, without the prototype, so the methods are gone |
| A custom `Error` subclass | A plain `Error` keeping `name`, `message`, `stack` and `cause`, so `instanceof` breaks but `error.name` still works |
| An `Event` subclass | A generic `Event` without the subclass fields, so a `MessageEvent` arrives without its `data` |
| An `EventTarget` | A listener-only façade |
| The same object in two places | Two independent copies |
| A typed array view covering part of its buffer | A copy of just that window |
| `WeakMap`, `WeakSet` and other context-bound values | Nothing, they cannot cross at all |

Classes are the one you will hit first: osra only descends into plain objects and arrays, so it never looks inside a class instance, and structured clone drops the prototype.\
Two sharper edges follow from that: an instance holding a function-valued own property (an arrow-function class field) coerces to `{}` entirely, data included, and a function nested inside a class instance is not proxied even though the same function on a plain object would be.\
Use plain objects and functions, or write a [custom revivable](/guides/custom-revivables/) for the class. Built-in `Error` classes are the exception and revive properly, see [supported types](/guides/supported-types/#errors).

If you need the extra fields of an `Event` subclass, extract them and send them alongside the event, see [supported types](/guides/supported-types/#events).

The `EventTarget` façade is listener-only, and the registration itself travels as a message.\
This means that events the source fires before your `addEventListener` call lands on it are missed entirely, with no way to catch up on them, and calling `dispatchEvent` on the façade does nothing, events only flow from the source outward.\
More detail in [supported types](/guides/supported-types/#eventtarget).

Also keep in mind that osra walks your value as a tree, not a graph.\
An object appearing in two places arrives as two independent copies, and when a single shared reference matters, mark it with [`identity()`](/guides/identity-and-transfer/#identity).\
A structure that contains itself is a real cycle though, and fails at send time with a `TypeError` telling you to break the cycle, while one arriving from a peer fails on receive with `TypeError('osra: cannot revive a circular structure')`.

Note: a typed array view covering only part of its buffer has that window copied out before sending, so only a view covering its whole buffer can be moved without a copy, see [supported types](/guides/supported-types/#typed-arrays).

Values that are tied to their context by design, like `WeakMap` and `WeakSet`, have nothing osra could send.\
The [`Capable` check](/reference/typescript/#the-capable-check) rejects them where you wrote them, so the runtime coercion to `{}` is a last resort you should not hit.

## Connections

When several peers answer on the same key they all connect, and each one gets your exposed value and can call into it.\
Awaiting `expose()` only ever gives you the first of them, and stays resolved on it.\
To see the others, iterate the same result instead, each peer arrives as it connects, see [multiple peers](/guides/multiple-peers/#several-peers-one-expose).\
One thing to note is that peers connecting before anything iterates are buffered only up to the most recent 32, so start your loop early when every peer matters, see [connections](/guides/connections/#every-loop-sees-every-peer).

A remote `AbortSignal` does not fire when the connection dies, so it cannot serve as a liveness check.\
Use your own `unregisterSignal`, or the rejection of your pending calls, see [what survives a close](/guides/lifecycle/#what-survives-a-close).

If nobody ever answers, `expose()` stays pending forever.\
That is deliberate, it is what makes a late-loading iframe or a slow-starting worker connect at all, see [errors and lifecycle](/guides/lifecycle/#connecting).\
If you need a deadline, race the promise against a timeout, or abort the `unregisterSignal` you passed, which rejects it with your reason.

## JSON transports

A JSON transport carries text, so the structured-only half of the [supported types](/guides/supported-types/) table cannot cross it: `Blob`, `File`, `FileList`, `RegExp`, `DataView`, `SharedArrayBuffer`, `TransformStream` and the rest of the structured-clone family.\
You will not meet this at runtime, the type system rejects the value at compile time and blames the transport rather than the value, see [JSON transports check harder](/reference/typescript/#json-transports-check-harder).\
Send an `ArrayBuffer` or a `Uint8Array` instead.

The binary data that is allowed, buffers and typed arrays, is base64 encoded on the wire.\
This costs roughly a third more bytes plus the encoding time on both ends, so prefer a structured transport when you move a lot of binary data and have the choice.

Also keep in mind that [`transfer()`](/guides/identity-and-transfer/#transfer) degrades to a copy here, since there is no memory to hand over across a text protocol.\
The code still runs unchanged, it just copies.

## Platform

`Float16Array` needs both sides to have it.\
Node 23, Chrome 134, Firefox 128 and anything older ship without it, and a receiver on such a platform rejects with `Error('Unknown typed array type')` when the value arrives.

A `TransformStream` is always moved, never proxied, because structured clone cannot copy one, so the original is unusable on the sending side once it ships.\
The same goes for `OffscreenCanvas`, `MediaStreamTrack`, `RTCDataChannel` and `MIDIAccess`, the other transfer-only host objects.
