---
title: Transports
description: Every channel osra runs over, from workers and iframes to WebSockets and web extensions.
---

Transports are the channels osra uses to communicate between the different `expose()` calls.
As previously explained in [Transport Modes](/guides/transport-modes/), transports support different modes of communication depending on which you use.

The following table contains osra's natively supported transports, with their corresponding mode and notes related to them:

| Transport | Mode | Notes |
|---|---|---|
| [`Window`](https://developer.mozilla.org/en-US/docs/Web/API/Window) | structured | |
| [`DedicatedWorkerGlobalScope`](https://developer.mozilla.org/en-US/docs/Web/API/DedicatedWorkerGlobalScope) | structured | |
| [`MessagePort`](https://developer.mozilla.org/en-US/docs/Web/API/MessagePort) | structured | Osra automatically calls `.start()` on the port |
| [`SharedWorker`](https://developer.mozilla.org/en-US/docs/Web/API/SharedWorker) | structured | |
| [`ServiceWorker`](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorker) | structured | |
| [`WebSocket`](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket) | JSON | |
| WebExtension [`Port`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/Port) | JSON | |
| WebExtension [`runtime.onMessage`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/onMessage) | JSON | Receive only, pair it with a `sendMessage` emit |
| `{ emit, receive }` | either | See [custom transports](/guides/custom-transports/) |


#### Examples

The following examples demonstrate how osra can be used with each transport.

## Worker

```ts twoslash title="worker.ts"
type Payload = { mult: (a: number, b: number) => number }
// ---cut---
import { expose } from 'osra'

export const { mult } = await expose<Payload>(
  { add: (a: number, b: number) => a + b },
  { transport: globalThis }
)

await mult(3, 7) // 21
```

```ts twoslash title="main.ts"
type Payload = { add: (a: number, b: number) => number }
// ---cut---
import { expose } from 'osra'

const worker = new Worker('/worker.ts', { type: 'module' })

export const { add } = await expose<Payload>(
  { mult: (a: number, b: number) => a * b  },
  { transport: worker }
)

await add(40, 2) // 42
```

## Iframe

```ts twoslash title="iframe.ts"
type Payload = { mult: (a: number, b: number) => number }
// ---cut---
import { expose } from 'osra'

export const { mult } = await expose<Payload>(
  { add: (a: number, b: number) => a + b },
  {
    transport: { emit: window.parent, receive: window },
    origin: 'https://host.example.com'
  }
)

await mult(3, 7) // 21
```

```ts twoslash title="main.ts"
type Payload = { add: (a: number, b: number) => number }
// ---cut---
import { expose } from 'osra'

const iframe = document.querySelector('iframe')!

export const { add } = await expose<Payload>(
  { mult: (a: number, b: number) => a * b  },
  {
    transport: { emit: iframe.contentWindow!, receive: window },
    origin: 'https://app.example.com'
  }
)

await add(40, 2) // 42
```

## MessagePort

```ts twoslash
import { expose } from 'osra'
const { port1, port2 } = new MessageChannel()

export const { mult } = await expose<{ mult: (a: number, b: number) => number }>(
  { add: (a: number, b: number) => a + b },
  {
    transport: port1,
    origin: 'https://host.example.com'
  }
)

export const { add } = await expose<{ add: (a: number, b: number) => number }>(
  { mult: (a: number, b: number) => a * b  },
  {
    transport: port2,
    origin: 'https://iframe.example.com'
  }
)

await add(40, 2) // 42
await mult(3, 7) // 21
```

## SharedWorker
```ts twoslash title="shared-worker.ts"
import { expose } from 'osra'

globalThis.addEventListener('connect', event => {
  for (const port of (event as MessageEvent).ports) {
    expose(
      { add: (a: number, b: number) => a + b },
      { transport: port }
    )
  }
})
```

```ts twoslash title="main.ts"
type Payload = { add: (a: number, b: number) => number }
// ---cut---
import { expose } from 'osra'

const sharedWorker = new SharedWorker('/shared.ts', { type: 'module' })

const { add } = await expose<Payload>({}, { transport: sharedWorker })

await add(40, 2) // 42
```

## Service worker

```ts twoslash title="service-worker.ts"
type Payload = { add: (a: number, b: number) => number }
// ---cut---
import { expose } from 'osra'

addEventListener("message", async (event) => {
  const { add } = await expose<Payload>(
    { mult: (a: number, b: number) => a * b },
    { transport: event.ports[0] }
  )
  
  await add(40, 2) // 42
})
```

```ts twoslash title="main.ts"
type Payload = { mult: (a: number, b: number) => number }
// ---cut---
import { expose } from 'osra'

const { port1, port2 } = new MessageChannel()
const registration = await navigator.serviceWorker.ready
registration.active!.postMessage(port1, [port1])

const { mult } = await expose<Payload>(
  { add: (a: number, b: number) => a + b },
  { transport: port2 }
)

await mult(3, 7) // 21
```

## WebSocket
```ts twoslash title="server.ts"
type Payload = { add: (a: number, b: number) => number }
// ---cut---
import { WebSocketServer } from 'ws'
import { expose } from 'osra'

const wss = new WebSocketServer({ port: 8080 })

wss.on('connection', async ws => {
  const { add } = await expose<Payload>(
    { mult: (a: number, b: number) => a * b },
    {
      transport: {
        isJson: true,
        emit: (data) => ws.send(data.toString()),
        receive: (listener) => {
          ws.on('message', data => {
            listener(JSON.parse(data.toString()), {})
          })
        }
      }
    }
  )
  
  await add(40, 2) // 42
})
```

```ts twoslash title="client.ts"
type Payload = { mult: (a: number, b: number) => number }
// ---cut---
import { expose } from 'osra'

const socket = new WebSocket('wss://example.com')
const { mult } = await expose<Payload>(
  { add: (a: number, b: number) => a + b },
  { transport: socket }
)

await mult(3, 7) // 21
```

## WebExtension

Osra natively supports WebExtension transports, but there is an important
thing to know about WebExtensions; if communicating with a MV3 service-worker,
that service-worker might be unloaded and cause issues with the osra connection.

This means that if you have long lived promises, if the SW unloads during these,
the promise will never resolve.

### MV3 service-worker connection

Per the spec, service-workers are unloaded after 5 minutes of inactivity
even if connections are open, in practice, this means that if you are
communicating with a MV3 service-worker, you should reconnect when
you receive a `disconnect` event.

```ts twoslash title="content-script.ts"
import { runtime } from 'webextension-polyfill'
type Payload = { add: (a: number, b: number) => number }
// ---cut---
import { expose } from 'osra'

const port = runtime.connect()
const { add } = await expose<Payload>(
  { mult: (a: number, b: number) => a * b },
  { transport: port }
)

await add(40, 2) // 42
```

```ts twoslash title="background.ts"
import { runtime } from 'webextension-polyfill'
type Payload = { mult: (a: number, b: number) => number }
// ---cut---
import { expose } from 'osra'

const backgroundApi = { fetchData: async (url: string) => (await fetch(url)).text() }
export type BackgroundApi = typeof backgroundApi

runtime.onConnect.addListener(async port => {
  const { mult } = await expose<Payload>(
    { add: (a: number, b: number) => a + b },
    { transport: port }
  )
  
  await mult(3, 7) // 21
})
```

### connectionless

You can also communicate to service-workers via `runtime.sendMessage`
and `runtime.onMessage`, which makes them connectionless.

With the same caveat of the connection based communication,
if the service-worker unloads, any in-flight requests will fail
and you need to re-`expose()` to make a new connection.

```ts twoslash title="content-script.ts"
import { runtime } from 'webextension-polyfill'
type Payload = { add: (a: number, b: number) => number }
// ---cut---
import { expose } from 'osra'

const { add } = await expose<Payload>(
  { mult: (a: number, b: number) => a * b },
  {
    transport: {
      isJson: true,
      emit: message => runtime.sendMessage(message),
      receive: runtime.onMessage
    }
  }
)

await add(40, 2) // 42
```

```ts twoslash title="background.ts"
import type { Runtime } from 'webextension-polyfill'
import { runtime, tabs } from 'webextension-polyfill'
type Payload = { mult: (a: number, b: number) => number }
// ---cut---
import type { ReceiveHandler } from 'osra'

import { expose, checkOsraMessageKey, OSRA_DEFAULT_KEY } from 'osra'

type Listener = Parameters<ReceiveHandler>[0]

const peers = new Map<number, Promise<Listener>>()

const peer = (tabId: number) => {
  const existing = peers.get(tabId)
  if (existing) return existing
  const { promise, resolve } = Promise.withResolvers<Listener>()
  peers.set(tabId, promise)
  expose<Payload>(
    { add: (a: number, b: number) => a + b },
    {
      transport: {
        isJson: true,
        receive: listener => resolve(listener),
        emit: message => { tabs.sendMessage(tabId, message) }
      }
    }
  )
  return promise
}

runtime.onMessage.addListener((message: unknown, sender: Runtime.MessageSender) => {
  const tabId = sender.tab?.id
  if (tabId === undefined) return
  if (!checkOsraMessageKey(message, OSRA_DEFAULT_KEY)) return
  peer(tabId).then(listener => listener(message, { sender }))
})
```
