---
title: Transports
description: Every channel osra runs over, from workers and iframes to WebSockets and web extensions.
---

The following table contains osra's supported transports:

| Transport | Mode | Notes |
|---|---|---|
| [`Window`](https://developer.mozilla.org/en-US/docs/Web/API/Window) | structured | |
| [`DedicatedWorkerGlobalScope`](https://developer.mozilla.org/en-US/docs/Web/API/DedicatedWorkerGlobalScope) | structured | |
| [`MessagePort`](https://developer.mozilla.org/en-US/docs/Web/API/MessagePort) | structured | Osra automatically calls `.start()` on the port |
| [`SharedWorker`](https://developer.mozilla.org/en-US/docs/Web/API/SharedWorker) | structured | |
| [`ServiceWorker`](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorker) | structured | |
| [`WebSocket`](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket) | JSON | |
| WebExtension [`Port`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/Port) | JSON | |
| `{ emit, receive }` | either | See [custom transports](/guides/custom-transports/) |

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

## Web extension

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
