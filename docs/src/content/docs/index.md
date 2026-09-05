---
title: 'osra: typed RPC across JavaScript contexts'
description: Strictly typed, ergonomic and lightweight (13 kB gzipped) RPC library in TypeScript. Send complex types and call functions across contexts with inferred typing and pluggable transports.
template: splash
hero:
  title: osra
  tagline: '<p>Strictly typed, ergonomic and lightweight (13&nbsp;kB gzipped) RPC library in TypeScript.</p><p>Send complex types and call functions across contexts with inferred typing and pluggable transports.</p>'
  actions:
    - text: Get started
      link: /general/getting-started/
      icon: right-arrow
    - text: View on GitHub
      link: https://github.com/Banou26/osra
      variant: minimal
      icon: github
# every other page is titled "Page | osra"; this page is the site, so its tab and link embed carry the whole title.
# The search snippet gets a shorter description than the embed: a result clips near 160 characters, an unfurl shows 300.
head:
  - tag: title
    content: 'osra: typed RPC across JavaScript contexts'
  - tag: meta
    attrs: { property: 'og:type', content: 'website' }
  - tag: meta
    attrs: { name: 'description', content: 'Strictly typed, ergonomic and lightweight (13 kB gzipped) RPC library in TypeScript. Send complex types and call functions across contexts.' }
---

Osra makes your multi-context code look like normal code.\
Zero boilerplate, and the best error messages you've ever seen.

## What it does

Each side calls `expose()` once with the value it wants to share, and gets the other side's value back, ready to use.\
Functions stay callable, generators stream, errors and abort signals cross, and what you get back is typed from what the peer exposed.

It runs over workers, shared and service workers, windows and iframes, `MessagePort`, WebSockets, web extensions and Node.js worker threads, or anything you can wrap in an `{ emit, receive }` pair.

```ts twoslash title="worker.ts"
import { expose } from 'osra'

const payload = {
  hash: crypto.getRandomValues(new Uint8Array(10)),
  add: (a: number, b: number) => a + b,
  makeCounter: () => {
    let count = 0
    return () => ++count
  },
  streamData: async function* () { yield* [0, 1, 2] }
}
export type Payload = typeof payload

expose(payload, { transport: globalThis })
```

```ts twoslash title="main.ts"
// @filename: worker.ts
import { expose } from 'osra'
const payload = {
  hash: crypto.getRandomValues(new Uint8Array(10)),
  add: (a: number, b: number) => a + b,
  makeCounter: () => {
    let count = 0
    return () => ++count
  },
  streamData: async function* () { yield* [0, 1, 2] }
}
export type Payload = typeof payload
expose(payload, { transport: globalThis })
// @filename: main.ts
// ---cut---
import type { Payload } from './worker'
import { expose } from 'osra'

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })

export const {
  hash, // Uint8Array
  add, // (a: number, b: number) => Promise<number>
  makeCounter, // () => Promise<() => Promise<number>>
  streamData, // () => Promise<AsyncIterableIterator<number>>
} = await expose<Payload>({}, { transport: worker })

hash.byteLength // 10

await add(40, 2) // 42

const counter = await makeCounter()
await counter() // 1
await counter() // 2

for await (const n of await streamData()) {
  console.log(n) // 0, 1, 2
}
```

Those are the real types, compiled against the published package. Hover any symbol to see them.

## Errors before they happen

Anything your transport cannot carry is rejected where you wrote it, with the path to the offending value.\
A `File` can cross to a worker, but not over a WebSocket, so this fails at compile time instead of arriving mangled:

```ts twoslash
// @errors: 2345
import { expose } from 'osra'
// ---cut---
expose({ foo: new File([], '') }, { transport: new WebSocket('') })
```

## Why osra

- **Efficient transport modes**: structured clone by default (workers, windows, `MessagePort`), which can move values instead of copying them, and JSON where the channel carries text (WebSockets, web extensions). See [transport modes](/guides/transport-modes/).
- **Wide type support**: functions, promises, async generators, `ReadableStream`, `Response`, `Map`, `Uint8Array`, `AbortSignal`, errors and [many more](/guides/supported-types/).
- **Explicit TypeScript errors**: the whole codebase is strictly typed, and anything your transport cannot carry fails at compile time, pointing at the exact field. See [TypeScript](/reference/typescript/).
- **Small and dependency free**: 13 kB gzipped, zero runtime dependencies, tested on Chromium, Firefox and WebKit through Playwright, and on Node.js 22 and 24.

Head to [getting started](/general/getting-started/) to see it running, or to the [overview](/general/overview/) for a map of these docs.
