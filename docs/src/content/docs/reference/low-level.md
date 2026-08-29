---
title: Low-level API
description: startConnections(), relay(), the raw message helpers, and the type guards osra uses internally.
---

Everything on this page is exported from `osra` directly, but none of it is needed for everyday use, that is what [`expose()`](/reference/expose/) is for.\
These are the primitives `expose()` itself is built on, and you reach for them when building infrastructure around osra: relays, custom transports, tooling that inspects osra traffic, or your own typed wrapper.

## startConnections()

```ts
startConnections(value, options)
```

The engine underneath `expose()`.\
At runtime the two are the same thing: `expose()` only adds the compile time layer, the [`Capable`](/reference/typescript/) check that rejects unsendable values at the call site and the [`Remote<T>`](/reference/typescript/) mapping of the peer's value, then delegates straight to `startConnections()`.

```ts
const remote = await expose<Api>(value, { transport })
// behaves at runtime exactly like
const remote = await startConnections<Remote<Api>>(value, { transport })
```

It takes the same options as `expose()` and returns the same `Exposed` result: awaiting it gives the first peer, iterating it gives every peer as it connects.\
The handshake, the connection tracking and the teardown described in [errors and lifecycle](/guides/lifecycle/) all live here.

One thing to remember is that skipping `expose()` also skips its transport-aware type checking.\
The value is still typed as `Capable`, so a `WeakMap` still fails to compile, just with a plain assignability error instead of the [branded report](/reference/typescript/#reading-the-error), and the transport narrowing is gone entirely: a `File` over a WebSocket compiles here and only fails at runtime, where `expose()` would have rejected it at the call site.\
This means that `startConnections()` is only worth calling from plumbing where the typed layer gets in the way, for example when the value or the transport are only known at runtime.

If you try to pass a transport that cannot both emit and receive, the returned promise rejects immediately, since no connection can be established over half a channel.

## relay()

```ts
relay(transportA, transportB, options?)
```

Forwards osra traffic between two channels. Use it when two contexts cannot see each other, but both can see you.\
A worker and an iframe are the typical pair: neither holds a reference to the other, so the page in the middle relays between them.

```ts twoslash
import { relay } from 'osra'
declare const worker: Worker
declare const iframe: HTMLIFrameElement
// ---cut---
relay(worker, { emit: iframe.contentWindow!, receive: window }, { key: 'app' })
```

Only envelopes matching `key` are forwarded, and nothing is ever revived in the middle, so no value ever exists in the relay context.\
The two real ends still handshake directly with each other, the relay is invisible to them.\
Also keep in mind that every forwarded message goes through [`getTransferableObjects()`](#gettransferableobjects) again, so buffers that were moved into the relay context are moved out of it too.

| Option | |
|---|---|
| `key` | Which channel to forward. Defaults to osra's default key. |
| `origin` | Applies to both sides. |
| `originA` / `originB` | Per side, overriding `origin`. |
| `nameA` / `nameB` | Per side, only forward envelopes from a peer with this `name`. |
| `unregisterSignal` | Abort to unhook both directions. |

One thing to note is that each direction is hooked up independently: if one transport cannot receive or the other cannot emit, that direction is simply skipped, so a mismatched pair degrades to one way forwarding.

More context in [custom transports & relays](/guides/custom-transports-and-relays/#relays).

## registerOsraMessageListener()

```ts
registerOsraMessageListener({ listener, transport, key?, remoteName?, origin?, unregisterSignal? })
```

Subscribes to osra messages on a transport and hands them to you raw, still boxed, nothing revived.\
It knows how to listen on every transport kind: it parses JSON strings for you, listens on a `SharedWorker`'s `.port`, calls `.start()` on a `MessagePort`, and handles the whole web extension family.\
It also filters by `key`, `remoteName` and `origin` exactly the same way `expose()` does, because `expose()` uses it internally.

The reason to reach for it is the second argument your listener gets, which `expose()` does not surface:

| `MessageContext` | |
|---|---|
| `sender` | The web extension sender, when there is one. |
| `port` | The extension `Port` it arrived on. |
| `source` | The `MessageEventSource`, for window and worker messages. |
| `origin` | The `event.origin`, for window messages. |
| `receiveTransport` | The transport it came from. |

That makes it the way to filter extension messages by sender before osra ever processes them.\
`expose()` does surface the sender too, but only per connection through the [context](/guides/connections/#what-is-in-the-context), after the handshake has already run, where the remedy is `context.abort()`; here you can drop the message outright:

```ts twoslash title="background.ts"
import { runtime } from 'webextension-polyfill'
// ---cut---
import { expose, registerOsraMessageListener } from 'osra'

expose(
  { add: (a: number, b: number) => a + b },
  {
    transport: {
      isJson: true,
      emit: message => runtime.sendMessage(message),
      receive: listener =>
        registerOsraMessageListener({
          transport: runtime,
          listener: (message, context) => {
            if (context.sender?.id !== runtime.id) return
            listener(message, context)
          }
        })
    }
  }
)
```

One thing to remember is that `registerOsraMessageListener` filters with osra's default `key` when you do not pass one, so if your `expose()` uses a custom `key`, pass the same one here or every envelope will be silently dropped.\
Also keep in mind that a custom `receive` handler can return a cleanup function, and `registerOsraMessageListener` will call it when `unregisterSignal` aborts.

If you only need the filter itself, `checkOsraMessageKey(message, key)` is the guard it uses internally: it checks that a value is an osra envelope carrying that `key`.\
You can see it multiplexing peers by hand in the [connectionless extension example](/guides/transports/#connectionless).

## sendOsraMessage()

```ts
sendOsraMessage(transport, message, origin?, transferables?)
```

The other half. It picks the right send call for whatever transport you hand it:

| Transport | How it sends |
|---|---|
| `Window` | `postMessage(message, origin, transferables)` |
| `SharedWorker` | Posts on its `.port` |
| `WebSocket` | `JSON.stringify`, queued until `open` while the socket is still connecting |
| WebExtension runtime | `runtime.sendMessage()` |
| WebExtension `Port` | `port.postMessage()` |
| Custom `{ emit }` | Your `emit(message, transferables)` |
| Everything else | `postMessage(message, transferables)` |

Every message osra sends funnels through here, so two teardown behaviors are built in:

- A web extension `Port` throws on `postMessage` once disconnected. After the first such throw the port is remembered and further sends become no-ops, instead of one throw per message while a stream is still winding down.
- `runtime.sendMessage` rejects with "Receiving end does not exist" while nobody is listening yet, which is normal while osra announces itself, so exactly that rejection is swallowed and any other error stays visible.

## getTransferableObjects()

```ts
getTransferableObjects(message): Transferable[]
```

Walks a boxed message and collects the values that should be moved rather than copied on `postMessage`.\
Osra's connection layer runs it right before every send and passes the result to `sendOsraMessage()` as its `transferables` argument, and `relay()` does the same for every message it forwards.\
It is exported for infrastructure that sends envelopes itself and needs to build the same transfer list.

Three rules decide what ends up on the list:

- Values that structured clone refuses to copy (`MessagePort`, `ReadableStream`, `WritableStream`, `TransformStream`, `OffscreenCanvas`, ...) are always included, opted in or not.
- `SharedArrayBuffer` is never included, shared memory is meant to be shared, not moved.
- Every other transferable (`ArrayBuffer`, `ImageBitmap`, `VideoFrame`, ...) is only included inside a [`transfer()`](/guides/identity-and-transfer/) box, and only when the wrapper did not degrade to a copy.

## Type guards

The guards osra uses to recognise transports and values, exported so custom transports and revivables can make the same decisions.

**Transports:** `isTransport`, `isEmitTransport`, `isReceiveTransport`, `isCustomTransport`, `isCustomEmitTransport`, `isCustomReceiveTransport`, `isJsonOnlyTransport`, `isEmitJsonOnlyTransport`, `isReceiveJsonOnlyTransport`, plus `assertEmitTransport` and `assertReceiveTransport` which throw instead of returning `false`.

**Platform objects:** `isWindow`, `isWorker`, `isDedicatedWorker`, `isSharedWorker`, `isServiceWorker`, `isServiceWorkerContainer`, `isWebSocket`.

**Web extension:** `isWebExtensionRuntime`, `isWebExtensionPort`, `isWebExtensionOnConnect`, `isWebExtensionOnMessage`.

**Values:** `isTypedArray`, `isTransferable`, `isSharedArrayBuffer`, `isOsraMessage`, `isRevivableBox`, `instanceOfAny`.

Most of them probe `globalThis` before touching a constructor, and `instanceOfAny` skips constructors that do not exist, so a platform that never heard of `SharedWorker` or `Float16Array` does not crash them.\
`isWindow` is worth knowing about: a cross-origin window throws a `SecurityError` on most property access, so it probes only the few properties that never do.

## Boxing

`recursiveBox(value, context)` and `recursiveRevive(boxed, context)` are the two halves of osra's value walker, exported for [custom revivables](/guides/custom-revivables/#nested-values) that box their own fields.\
`BoxBase` is the marker every box spreads, and it is what `isRevivableBox` looks for.

A few behaviors worth knowing about:

- An already boxed value passes through `recursiveBox` untouched, so boxing a field twice is safe.
- Both walkers throw a `TypeError` on circular structures, which is why `expose()`'s promise can reject with one.
- For binary fields there is `boxBuffer(buffer, context)` and `reviveBuffer(boxed)`, the same pair osra's own modules use: a raw `ArrayBuffer` on structured transports, base64 on JSON ones.

The default module list is also exported as `defaultRevivableModules`, though the `revivableModules` option already hands it to you, so you rarely need the export itself.

## Constants

| | Value | |
|---|---|---|
| `OSRA_KEY` | `'__OSRA_KEY__'` | The envelope field holding the channel key. |
| `OSRA_DEFAULT_KEY` | `'__OSRA_DEFAULT_KEY__'` | The `key` used when you do not pass one. |
| `OSRA_BOX` | `'__OSRA_BOX__'` | The field marking an object as a revivable box. |

## Types

The public types, all importable from `osra` directly:

- Transports: `Transport`, `PlatformTransport`, `CustomTransport`, `EmitTransport`, `ReceiveTransport`, `EmitHandler`, `ReceiveHandler`
- Messages: `Message`, `MessageContext`, `Context`, `Uuid`
- Values: `Capable`, `Remote`, `RevivableModule`, `RevivableContext`, `BoxBase`
- Connections: `Exposed`, `Connected`, `Contextual`, `StartConnectionsOptions`, `RelayOptions`

`Remote`, `Capable`, `Exposed` and `Connected` have their own page: [TypeScript](/reference/typescript/).
