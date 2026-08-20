---
title: Custom transports
description: Wrap any channel in an { emit, receive } pair and run osra over it.
---

If osra's default does not fit your needs, osra support custom transports.
The custom transport interface is simplified as such in the
`expose(value, options)`'s `options.transport` parameter.

```ts
type CustomTransport = {
  emit?: (message: Message, transferables?: Transferable[]) => void
  receive?: (listener: (event: Message, messageContext: MessageContext) => void) => void
  isJson?: boolean
}
```

In truth though, the emit and receive functions allows a wider range of type
such as any of the [platform transports](/guides/transports/) allowed values.
This expanded type allows us to properly handle connections through Iframes.

For example, emit needs to `window.parent.postMessage` to the parent window,
while receive listens for messages on `window.addEventListener('message', ...)`.
```ts twoslash
import { expose } from 'osra'
// ---cut---
expose({}, { transport: { emit: window.parent, receive: window } })
```

## `isJson`

`isJson` tells osra whether your channel can carry structured-clone values.

## Transferables

The second argument to `emit` is the list of values that should be moved instead of copied. Forward it if your channel supports transfer:
If you do not pass this option, transferable values will be copied instead of moved.

```ts twoslash
import { expose } from 'osra'
// ---cut---
expose(
  {},
  {
    transport: {
      receive: window,
      emit: (message, transferables) =>
        window
          .parent
          .postMessage(message, { transfer: transferables })
    }
  }
)
```

## Relays

If you ever need to connect two contexts that cannot see each other directly,
use `relay()` to forward osra traffic.
For example, you could forward osra traffic from a worker to an iframe.

```ts twoslash
import { relay } from 'osra'
// ---cut---
const worker = new Worker('')
const iframe = document.querySelector('iframe')!
relay(worker, { emit: iframe.contentWindow!, receive: window })
```
