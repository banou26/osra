---
title: Custom transports
description: Wrap any channel in an { emit, receive } pair and run osra over it.
---

If osra's default does not fit your needs, osra support custom transports.
The custom transport interface is simplified as such in the `expose(value, options)`'s `options.transport` parameter.

```ts


type CustomTransport = {
  emit?: (message: Message, transferables?: Transferable[]) => void
  receive?: (listener: (event: Message, messageContext: MessageContext) => void) => void
  isJson?: boolean
}
```

In truth though, the emit and receive functions allows a wider range of type such as any of the [platform transports](/guides/transports/) allowed values

## isJson

`isJson` tells osra whether your channel can carry structured-clone values.

Leave it out and osra guesses by looking at what you passed. A `{ emit: someWebSocket }` is JSON, a `{ emit: somePort }` is not. Set it explicitly when your channel serializes behind your back, which is the case for anything that ends up in `JSON.stringify`, a text protocol, or a native bridge.

The optimistic direction is the one that fails: left unset, osra will box a `RegExp` or a `File` for a channel that cannot carry it. See [supported types](/guides/supported-types/) for what each mode allows.

## A BroadcastChannel

`receive` gets called once with osra's listener. Hand it every incoming message, and return an unsubscribe function if you have one.

```ts twoslash
import { expose } from 'osra'

type PeerApi = { hello: () => string }
const localApi = { hello: () => 'hi' }
// ---cut---
const channel = new BroadcastChannel('app')

const remote = await expose<PeerApi>(localApi, {
  transport: {
    isJson: true,
    emit: message => channel.postMessage(message),
    receive: listener => {
      const handler = (event: MessageEvent) => listener(event.data, {})
      channel.addEventListener('message', handler)
      return () => channel.removeEventListener('message', handler)
    }
  }
})
```

`receive` does not need to filter. osra ignores foreign messages, and drops envelopes whose `key` or `name` do not match.

## Transferables

The second argument to `emit` is the list of values that should be moved instead of copied. Forward it if your channel supports transfer:

```ts
emit: (message, transferables) => port.postMessage(message, transferables)
```

If you drop it, everything still works, it just gets copied. On a JSON channel there is nothing to forward, the list is always empty.

## Plain objects only

osra recognises a custom transport by its shape, so it has to be a plain object (`{}` or `Object.create(null)`). Class instances are deliberately not accepted, because plenty of them already have an `emit` method that means something else entirely. A Node `EventEmitter` is the usual example. Wrap it instead:

```ts
const transport = {
  emit: message => emitter.emit('osra', message),
  receive: listener => {
    const handler = message => listener(message, {})
    emitter.on('osra', handler)
    return () => emitter.off('osra', handler)
  }
}
```

## Bridging two transports

`relay()` forwards osra traffic between two channels without unpacking it. Use it when two contexts cannot see each other but both can see you, like a worker that needs to reach an iframe.

```ts twoslash
import { relay } from 'osra'

const worker = new Worker('')
const iframe = document.querySelector('iframe')!
// ---cut---
relay(worker, { emit: iframe.contentWindow!, receive: window })
```

The relay only touches envelopes matching its `key`, and it never revives anything, so no value ever exists in the middle. Both real ends still handshake with each other directly.

```ts twoslash
import { relay } from 'osra'
const a = new Worker('')
const b = new Worker('')
// ---cut---
const controller = new AbortController()

relay(a, b, {
  key: 'app',
  originA: 'https://host.example.com',
  originB: 'https://app.example.com',
  unregisterSignal: controller.signal
})
```

`origin` sets both sides at once, `originA` and `originB` override one each. `nameA` and `nameB` restrict which peer name each side accepts. Aborting `unregisterSignal` unhooks both listeners.

Keep both legs in the same mode. Each peer picks its boxing from its own transport, so a structured-mode peer relayed onto a JSON leg will produce values that leg cannot carry. If one side has to be JSON, mark the other one `isJson: true` as well.
