---
title: How it works
description: The handshake, the boxing walk, and the port routing underneath every live value.
---

Implementation notes. None of it is API, but it accounts for the behaviors the guides describe.

Two layers. The **connection** layer finds a peer and moves envelopes. The **revivable** layer boxes values into something sendable and revives them on arrival.

## The handshake

Both sides come up the same way, since neither is the server.

1. You call `expose()`. Your side generates a `uuid` and starts announcing: `{ type: 'announce' }`, sent on the transport.
2. A peer that hears an announce replies with its own, addressed back: `{ type: 'announce', remoteUuid }`.
3. Seeing an announce addressed to it, each side boxes its value and sends `{ type: 'init', remoteUuid, data }`.
4. Each side revives the `init` it receives, and resolves its `expose()` promise with the result.

A lone announce gets lost when nobody is listening yet, which happens constantly: iframes that have not loaded, workers that start late. So announcing retries, starting at 50ms and doubling up to a second, until a peer connects.

The announce is the one message sent with `targetOrigin: '*'` on window transports. A freshly created iframe is still on its initial `about:blank` document, and a strictly targeted message to it is dropped by the browser before it ever arrives. The announce carries nothing but the key, name and uuid. Everything with data in it goes out with your configured `origin`, and inbound filtering always applies.

When a side goes away it sends `{ type: 'close', remoteUuid }`, and the peer tears that connection down instead of leaving calls pending.

Messages carrying your own `uuid` are ignored, which is what makes broadcast-style channels work without a connection talking to itself.

## Envelopes

Every message on the wire has the same outer shape:

```ts
{
  [OSRA_KEY]: 'your-key',   // which channel
  uuid: 'sender-uuid',
  name: 'sender-name',      // when set
  type: 'announce' | 'init' | 'close' | 'message' | 'message-port-close' | 'identity-dispose',
  // plus whatever that type carries
}
```

Anything without the key field, or with a different key, is not this connection's business and gets dropped before anything else happens. That is what lets several connections share one channel.

On a WebSocket the envelope is `JSON.stringify`ed. Everywhere else it goes out as-is, with a transfer list.

## Boxing

`recursiveBox` walks your value once:

- If it is already a box, leave it alone.
- Find the first revivable module whose `isType` matches, and let it box the value.
- Otherwise, if it is an array or a plain object, walk into it and box each item.
- Otherwise, pass it through untouched.

That third rule is why classes do not survive: a class instance is not a plain object, so osra never descends into it. Structured clone still copies its data properties, but nothing inside gets boxed.

A box is a plain object carrying `[OSRA_BOX]: 'revivable'` and a `type`. Reviving is the same walk in reverse, matching modules by that `type` string.

Module order decides who wins. `eventTarget` sits last because `MessagePort`, `AbortSignal` and `Window` all extend `EventTarget` and need first pick. The catch-all that turns unclonable values into `{}` sits after everything else, and probes with `structuredClone` before giving up.

Cycles are caught by tracking the current path, not everything seen, so an object at two sibling positions is fine and only a true ancestor revisit throws.

## Ports

Every live value rides its own channel. A boxed function is a channel that carries calls, a boxed promise is a channel that carries one settlement, a boxed stream carries chunks.

How that channel is built depends on the transport:

**On a structured transport** it is a real `MessageChannel`. One port is transferred to the peer inside the box. It is wrapped so that anything posted through it is boxed on the way out and revived on the way in, which is what lets a function argument itself be a function.

**On a JSON transport** there is nothing to transfer, so the channel is synthetic. Each port gets a `portId`, and its traffic is multiplexed onto the main connection as `{ type: 'message', portId, seq, data }`.

The synthetic port is an `EventPort`, which deliberately does not extend `EventTarget`. Firefox content scripts and privileged sandboxes do not support subclassing platform interfaces: `super()` returns a bare `EventTarget` and every subclass method vanishes. `EventPort` keeps its own listener registry so it behaves the same in every realm.

### Ordering

A connectionless transport (`runtime.sendMessage`, for one) gives no ordering guarantee. A port's messages can arrive out of order, and even before the message that created the port.

So each side stamps its outgoing port messages with a monotonic `seq`, and the receiver buffers by `seq` and delivers strictly in send order once a handler exists. Neither reordering nor early arrival can drop or reorder a port's stream, which is what the stream protocol below relies on.

Three bounds keep a misbehaving peer from growing that state without limit: 2048 messages in a port's reorder buffer, 1024 ports awaiting their handler, and 128 remembered closed ports so late messages cannot resurrect one.

## Streams

A boxed `ReadableStream` uses a credit window. The consumer grants credit, the producer pushes up to it without waiting for anything, and tops up happen at half a window so there is roughly one credit message per half window of chunks.

The window starts at 8 and adapts between 2 and 64, tracking an exponential moving average of chunk size against a 4 MiB budget of data in flight. Chunks whose size cannot be measured hold at the initial window rather than jumping to the maximum, where the byte budget would no longer bound anything.

Delivered chunks are buffered outside the stream controller, because `controller.error()` discards whatever is queued in it, and an error arriving mid-stream must not eat data that already made it across.

A producer that pushes past its grant fails the stream with `osra: stream exceeded its credit window`.

## Cleanup

Three things clean up after themselves.

**Connections.** Closing runs a teardown registry: pending calls reject, ports close, streams cancel, caches clear.

**Ports.** Closing one tells the peer, which closes its end. A `FinalizationRegistry` is the backstop for a port nobody bothered to close, with the cleanup built in its own scope so it cannot accidentally hold a reference to the thing it is waiting to see collected.

**Identities and façades.** When a value sent with `identity()` is collected, its owner sends `identity-dispose` so the peer drops its cached copy, and a peer that had passed that value further along tells its own peer in turn, so a chain of contexts unwinds from the origin outward. When an `EventTarget` façade is collected, one call removes every listener it registered on the source.

## Version compatibility

The wire format stays backward compatible, and negotiation is by field presence rather than a version number.

A boxed stream advertises `credit: true`. A peer that does not see it speaks the older pull protocol instead, one round trip per chunk. Port messages without a `seq` come from a version that predates reordering and are delivered in arrival order.

That matters more than it looks. Two contexts in one app can be built at different times, against different osra versions, and still have to talk.
