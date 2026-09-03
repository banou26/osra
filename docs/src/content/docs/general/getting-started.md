---
title: Getting started
description: Installation and quick examples of using osra.
---

If you like to learn by examples, you're in the right place.\
In case you'd rather go through a more in-depth documentation, you can start at the [overview](/general/overview).

We'll go through some basic and more advanced examples to osra in this page.

## Install

```sh
npm install osra
```

## Simple cross context communication

If you have a worker(nodejs worker, web worker, doesn't matter) and you'd like to call a function from your main thread, using osra, it's as simple as calling [`expose(value, options)`](/reference/expose).

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

Osra natively supports almost all of the types you'd encounter on the web platform, not just functions.\
If you'd like to see every supported types, you can head over at the [supported types](/guides/supported-types/) page.

## Callbacks, generators and cancellation

Functions aren't limited to the top level of what you expose.\
A function passed as an argument becomes a function the worker can call back, an async generator streams its items one at a time, and an `AbortSignal` cancels work on the other side.

```ts twoslash title="worker.ts"
import { expose } from 'osra'
// ---cut---
const payload = {
  countTo: async (n: number, onTick: (i: number) => void) => {
    for (let i = 1; i <= n; i++) onTick(i)
    return 'done'
  },
  fibonacci: async function* () {
    let [a, b] = [0, 1]
    while (true) {
      yield a
      ;[a, b] = [b, a + b]
    }
  },
  wait: (ms: number, signal: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => resolve('finished'), ms)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(signal.reason)
      })
    })
}
export type Payload = typeof payload

expose(payload, { transport: globalThis })
```

```ts twoslash title="main.ts"
// @filename: worker.ts
const payload = {
  countTo: async (n: number, onTick: (i: number) => void) => {
    for (let i = 1; i <= n; i++) onTick(i)
    return 'done'
  },
  fibonacci: async function* () {
    let [a, b] = [0, 1]
    while (true) {
      yield a
      ;[a, b] = [b, a + b]
    }
  },
  wait: (ms: number, signal: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => resolve('finished'), ms)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(signal.reason)
      })
    })
}
export type Payload = typeof payload
// @filename: main.ts
// ---cut---
import type { Payload } from './worker'
import { expose } from 'osra'

const worker = new Worker('/worker.ts', { type: 'module' })

const { countTo, fibonacci, wait } = await expose<Payload>({}, { transport: worker })

await countTo(3, i => console.log(i)) // logs 1, 2, 3 and resolves with 'done'

for await (const n of await fibonacci()) {
  if (n > 20) break // stops the generator in the worker too
  console.log(n) // 0, 1, 1, 2, 3, 5, 8, 13
}

const controller = new AbortController()
const pending = wait(10_000, controller.signal)
controller.abort(new Error('changed my mind'))
await pending // rejects with Error('changed my mind')
```

Everything you pass along goes through the same treatment, whatever its depth.\
The `onTick` callback arrives in the worker as an async function, the generator's `next()` and `return()` are proxied so `break` cleans up on the worker side, and aborting the signal aborts its twin in the worker with the same reason.

One thing to note is that every call and every generator item is a round trip.\
That is fine for the examples above, but for bulk data prefer a `ReadableStream`, which pipelines, see [revivables](/guides/revivables/).

## Streams, transfer and both directions

In osra there is no client and no server: both sides expose a value, and both sides get the other's back.\
This worker exposes two functions that take a stream, and calls a `log` function the page exposed as soon as they are connected.

```ts twoslash title="worker.ts"
import { expose, transfer } from 'osra'

type PageApi = { log: (line: string) => void }

const payload = {
  sha256: async (stream: ReadableStream<Uint8Array<ArrayBuffer>>) => {
    const bytes = await new Response(stream).arrayBuffer()
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  },
  gzip: (stream: ReadableStream<Uint8Array<ArrayBuffer>>) =>
    transfer(stream.pipeThrough(new CompressionStream('gzip')))
}
export type Payload = typeof payload

const page = await expose<PageApi>(payload, { transport: globalThis })

await page.log('ready')
```

```ts twoslash title="main.ts"
// @filename: worker.ts
import { expose, transfer } from 'osra'
type PageApi = { log: (line: string) => void }
const payload = {
  sha256: async (stream: ReadableStream<Uint8Array<ArrayBuffer>>) => {
    const bytes = await new Response(stream).arrayBuffer()
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  },
  gzip: (stream: ReadableStream<Uint8Array<ArrayBuffer>>) =>
    transfer(stream.pipeThrough(new CompressionStream('gzip')))
}
export type Payload = typeof payload
const page = await expose<PageApi>(payload, { transport: globalThis })
await page.log('ready')
// @filename: main.ts
// ---cut---
import type { Payload } from './worker'
import { expose, transfer } from 'osra'

const worker = new Worker('/worker.ts', { type: 'module' })
const controller = new AbortController()

const { sha256, gzip } = await expose<Payload>(
  { log: (line: string) => console.log(`worker says: ${line}`) }, // logs "worker says: ready"
  { transport: worker, unregisterSignal: controller.signal }
)

const file = new File(['hello osra'], 'hello.txt')

// the file's chunks are moved to the worker instead of being copied
await sha256(transfer(file.stream())) // 'e3c59cf7…'

// the compressed chunks stream back the same way, as the worker produces them
const compressed = await new Response(await gzip(transfer(file.stream()))).blob()

controller.abort() // done with the worker, close the connection
```

A `ReadableStream` is never copied as a whole, it's proxied chunk by chunk with backpressure, so the page starts receiving compressed chunks while the worker is still reading the file.\
Wrapping a stream in [`transfer()`](/guides/identity-and-transfer/) moves each chunk's buffer instead of copying it, and leaving it out still works, just with a copy per chunk.

Aborting `unregisterSignal` closes the connection on both sides and rejects anything still in flight, see [errors and lifecycle](/guides/lifecycle/).

From here, [transport modes](/guides/transport-modes/) explains which values can cross which channels, and [transports](/guides/transports/) shows the same `expose()` call on iframes, shared workers, WebSockets and web extensions.


<!--
## Transports

On the web, there are two different types of values.\
The first ones are


- Structured
- JSON
-->
