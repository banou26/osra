---
title: Getting started
description: Installation and quick examples of using osra.
---

If you like to learn by examples, you're in the right place.\
In case you'd rather go through a more in-depth documentation, you can start at the [overview](/general/overview).

We'll go through some basic and more advanced examples when using osra in this page.

## Install

```sh
npm install osra
```

## Simple cross context communication

If you have a worker(nodejs worker, web worker, doesn't matter).\
And you'd like to call a function from your main thread.\
Using Osra, it's as simple as calling [`expose(value, options)`](/reference/expose).

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

## Transports

On the web, there are two different types of values.\
The first ones are


- Structured
- JSON

