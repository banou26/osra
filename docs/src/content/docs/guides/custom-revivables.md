---
title: Custom revivables
description: Teach osra how to send a type it does not know, like your own class.
---

Every type osra knows how to [send](/guides/supported-types/) is implemented as a small module: a guard that recognizes the value, a `box` function that flattens it into something the wire can carry, and a `revive` function that rebuilds it on the other side.\
The defaults are an ordered list of those modules, and the `revivableModules` option of `expose()` hands you that list so you can extend it, reorder it, or replace parts of it.

This is also the way to get your own classes across.\
If you try to send an instance of your own class, osra rejects it at compile time, because it has no way to rebuild an arbitrary prototype on the other side.\
And even if it went through, structured clone would only keep the instance's own data fields, so it would arrive as a plain object stripped of its methods.

A custom module fills exactly that gap: you tell osra how to flatten the instance, and how to build a real one back from those fields.

## A module

Here is a module for a small `Point` class:

```ts twoslash
import type { RevivableContext, RevivableModule } from 'osra'
import { BoxBase } from 'osra'

class Point {
  constructor(public x: number, public y: number) {}
  distance() { return Math.hypot(this.x, this.y) }
}

const point = {
  type: 'point' as const,
  objectsOnly: true,
  isType: (value: unknown): value is Point => value instanceof Point,
  box: (value: Point, _context: RevivableContext) => ({
    ...BoxBase,
    type: 'point' as const,
    x: value.x,
    y: value.y
  }),
  revive: (value: { x: number, y: number }, _context: RevivableContext) =>
    new Point(value.x, value.y)
} as const satisfies RevivableModule
```

| Field | |
|---|---|
| `type` | Names the box on the wire. Keep it unique within the list, reviving picks the first module whose `type` matches. |
| `isType` | Decides whether this module handles a value on the way out. |
| `box` | Flattens the value into something sendable. Spread `BoxBase` into the result so osra recognizes it as a box, and keep the `type` field on it. |
| `revive` | Rebuilds the value on the receiving side, from exactly the fields `box` produced. |
| `objectsOnly` | Optional. Set it to `true` when `isType` never claims a primitive, so osra skips your module for strings, numbers and the like. Most modules qualify. |
| `init` | Optional. Runs once when a connection starts, see [live values](#live-values). |
| `Messages` | Optional. Declares the custom message types your module sends, see [live values](#live-values). |

One thing to note is that both `box` and `revive` are synchronous.\
Osra runs them inline while it serializes and deserializes messages, so they must return their result directly, never a `Promise`.\
If your type needs to keep talking after it was sent, the way functions and streams do, that is what [live values](#live-values) are for.

Also keep in mind that whatever `box` returns is sent as is, osra does not walk into your box looking for more values to convert.\
Plain JSON data like the two numbers above is always safe, but a field holding a `Date`, a function, or another `Point` needs to be boxed by you, see [nested values](#nested-values).

## Using it

`revivableModules` is a function that receives the default module list and returns the list you actually want.\
Putting your module in front of the defaults is the usual shape, and typing the parameter as `DefaultRevivableModules` is what lets osra infer the final list from the option:

```ts twoslash title="main.ts"
// @filename: point.ts
import type { RevivableContext, RevivableModule } from 'osra'
import { BoxBase } from 'osra'
export class Point {
  constructor(public x: number, public y: number) {}
  distance() { return Math.hypot(this.x, this.y) }
}
export const point = {
  type: 'point' as const,
  objectsOnly: true,
  isType: (value: unknown): value is Point => value instanceof Point,
  box: (value: Point, _context: RevivableContext) => ({
    ...BoxBase, type: 'point' as const, x: value.x, y: value.y
  }),
  revive: (value: { x: number, y: number }, _context: RevivableContext) =>
    new Point(value.x, value.y)
} as const satisfies RevivableModule
// @filename: main.ts
declare const transport: Worker
// ---cut---
import type { DefaultRevivableModules } from 'osra'
import { expose } from 'osra'
import { Point, point } from './point'

const withPoint = (defaults: DefaultRevivableModules) => [point, ...defaults] as const

const payload = { scale: (p: Point) => new Point(p.x * 2, p.y * 2) }

expose(payload, { transport, revivableModules: withPoint })

const remote = await expose<typeof payload, ReturnType<typeof withPoint>>(
  {},
  { transport, revivableModules: withPoint }
)

const doubled = await remote.scale(new Point(3, 4))
doubled.distance() // 10, a real Point with its methods
```

Both sides need the same list.\
The peer needs your `revive` to rebuild the value, and the same `type` string to find the right module.\
A side that does not know the `type` hands your code the raw box, a plain object carrying the wire fields, instead of a `Point`.

On the side that names the peer's type, pass the module list's type as the second type argument too, `ReturnType<typeof withPoint>` above.\
That second type argument is what lets the compile time `Capable` check know about your type.\
TypeScript has no partial inference, so naming `typeof payload` alone resets the module list back to the defaults, and the error lands on `revivableModules: withPoint`, since the option then expects a function returning the default list.\
The bare `expose(payload, ...)` call needs no type arguments at all, everything is inferred from the options.

One thing to note is that [`Remote<T>`](/reference/typescript/) does not know about your module either, so on the peer's type your class's methods show up as async.\
At runtime they are the real methods of a real instance, `doubled.distance()` above returns `10` synchronously.

Note: none of this is tied to structured transports.\
A custom module works on [JSON transports](/guides/transport-modes/) too, as long as what its `box` produces is JSON safe or [boxed](#nested-values) the rest of the way.

## Ordering

Boxing walks the list front to back and the first `isType` that matches wins.\
Reviving looks the module up by its `type` string instead, so on that side the order does not matter.

This means that putting your module first lets it win over the defaults.\
That is what you want when your class extends something a default already handles, an `Error` subclass for example: your module sees the value before the generic error one does, so your extra fields survive.

Dropping or replacing a default works the same way, since you receive the whole list and return whatever you like:

```ts twoslash
import type { DefaultRevivableModules, RevivableModule } from 'osra'
declare const myDate: RevivableModule
// ---cut---
const modules = (defaults: DefaultRevivableModules) =>
  [myDate, ...defaults.filter(m => m.type !== 'date')] as const
```

Be careful when reordering the defaults though, a few of them depend on their position:

- The async iterator module sits before the fallbacks, otherwise generators would fall through and coerce to `{}`.
- `clonable` and `transferable` sit before `eventTarget`, because `OffscreenCanvas` and friends also extend `EventTarget`.
- `blob` sits after `clonable`, so a `File`, which extends `Blob`, keeps riding the more specific `clonable` path.
- `eventTarget` sits last among the modules matching `EventTarget` subclasses, since `MessagePort` and `AbortSignal` need first pick.
- `unclonable` sits at the very end: it is the catch-all that probes values with `structuredClone()` and turns whatever fails into `{}`.

## Nested values

When your module claims a value, osra stops walking: your `box` runs, and its result ships untouched.\
This means that any field of your box that itself needs osra's treatment, a function, a stream, another custom class, has to go through the walker explicitly.

Call `recursiveBox` on it with the context you were handed, and mirror it with `recursiveRevive` on the other side.\
This is exactly what the built-in `Map`, `Error` and `CustomEvent` modules do for their own fields:

```ts twoslash
import type { RevivableContext } from 'osra'
import { BoxBase, recursiveBox, recursiveRevive } from 'osra'

class Result {
  constructor(public value: unknown, public at: Date) {}
}
// ---cut---
const result = {
  type: 'result' as const,
  objectsOnly: true,
  isType: (value: unknown): value is Result => value instanceof Result,
  box: (value: Result, context: RevivableContext) => ({
    ...BoxBase,
    type: 'result' as const,
    value: recursiveBox(value.value as never, context),
    at: recursiveBox(value.at as never, context)
  }),
  revive: (value: { value: unknown, at: unknown }, context: RevivableContext) =>
    new Result(
      recursiveRevive(value.value as never, context),
      recursiveRevive(value.at as never, context) as unknown as Date
    )
}
```

Fields holding plain JSON data (strings, numbers, booleans, and arrays or plain objects of those) can stay raw, they survive any transport as they are.\
On a structured transport other clonables happen to survive raw too, but on a [JSON transport](/guides/transport-modes/) a raw `Date` field would silently turn into a string, so going through `recursiveBox` is what keeps a module correct on both modes.

One thing to note is that a module claiming a value in place, rather than a wrapper around one, needs [`boxClaimedValue(value, context, yourType)`](/reference/low-level/#boxing) for its payload instead.\
It walks the value through every other module while skipping yours, which `recursiveBox` on that same value would hand straight back to you. `identity()` is the built-in example, since it marks a reference rather than wrapping it.

## Live values

A wrapper like `Point` is done the moment it arrives.\
A live value keeps talking after it was sent, the way a function keeps receiving calls, or a stream keeps receiving chunks.

Both `box` and `revive` receive the connection's context as their second argument, and it has everything a live value needs:

| Field | |
|---|---|
| `sendMessage` | Sends a message of your own to the peer. It must carry a `type` of your choosing and the `remoteUuid` of the connection. |
| `eventTarget` | Where this connection's incoming messages are dispatched, as `CustomEvent`s with the message on `event.detail`. |
| `remoteUuid` | The peer this connection belongs to. |
| `transport` | The normalized transport. Useful as `isJsonOnlyTransport(context.transport)` when your wire format differs per mode. |
| `revivableModules` | The resolved module list of this connection. |

The pattern every built-in live value follows is that `box` registers some local state and returns a plain descriptor, updates flow through `sendMessage`, and a listener on `eventTarget` picks them up on the other side.

Here it is for a `Cell`, a value you can subscribe to.\
The peer gets a cell of its own that follows the original:

```ts twoslash title="cell.ts"
import type { Capable, DefaultRevivableModules, RevivableContext, RevivableModule } from 'osra'
import { BoxBase, onTeardown, recursiveBox, recursiveRevive } from 'osra'

export class Cell<T> {
  #value: T
  #listeners = new Set<(value: T) => void>()
  constructor(value: T) { this.#value = value }
  get value() { return this.#value }
  set(value: T) {
    this.#value = value
    for (const listener of this.#listeners) listener(value)
  }
  subscribe(listener: (value: T) => void) {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }
}

type CellSet = { type: 'cell-set', cellId: string, value: Capable }
const isCellSet = (message: { type: string }): message is CellSet => message.type === 'cell-set'

export const cell = {
  type: 'cell' as const,
  objectsOnly: true,
  isType: (value: unknown): value is Cell<any> => value instanceof Cell,
  box: (value: Cell<any>, context: RevivableContext) => {
    const cellId = crypto.randomUUID()
    const unsubscribe = value.subscribe(next => {
      context.sendMessage({
        type: 'cell-set',
        remoteUuid: context.remoteUuid,
        cellId,
        value: recursiveBox(next, context)
      })
    })
    onTeardown(context, unsubscribe)
    return { ...BoxBase, type: 'cell' as const, cellId, value: recursiveBox(value.value, context) }
  },
  revive: (boxed: { cellId: string, value: Capable }, context: RevivableContext) => {
    const revived = new Cell(recursiveRevive(boxed.value, context))
    context.eventTarget.addEventListener('message', (event: CustomEvent<{ type: string }>) => {
      if (!isCellSet(event.detail) || event.detail.cellId !== boxed.cellId) return
      revived.set(recursiveRevive(event.detail.value, context))
    })
    return revived
  }
} as const satisfies RevivableModule

export const withCell = (defaults: DefaultRevivableModules) => [cell, ...defaults] as const
```

A few things to note about it:

- `box` gives each cell an id and puts it in the box, so `revive` can tell which messages are for it. Every message on the connection reaches every listener, so filtering by `type` and by that id is what keeps modules from hearing each other's traffic.
- `sendMessage` wraps your message in osra's envelope and routes it to this connection's peer, which is why it needs `context.remoteUuid`.
- The listener types its event as `CustomEvent<{ type: string }>`, since the messages of every module flow through the same target, and narrows down to its own message with a type guard.
- `onTeardown(context, fn)` runs `fn` when the connection closes, so the subscription does not outlive it.

Using it is the same as before, both sides register the module and the reading side names it in the second type argument:

```ts twoslash title="worker.ts"
// @filename: cell.ts
import type { Capable, DefaultRevivableModules, RevivableContext, RevivableModule } from 'osra'
import { BoxBase, onTeardown, recursiveBox, recursiveRevive } from 'osra'
export class Cell<T> {
  #value: T
  #listeners = new Set<(value: T) => void>()
  constructor(value: T) { this.#value = value }
  get value() { return this.#value }
  set(value: T) {
    this.#value = value
    for (const listener of this.#listeners) listener(value)
  }
  subscribe(listener: (value: T) => void) {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }
}
type CellSet = { type: 'cell-set', cellId: string, value: Capable }
const isCellSet = (message: { type: string }): message is CellSet => message.type === 'cell-set'
export const cell = {
  type: 'cell' as const,
  objectsOnly: true,
  isType: (value: unknown): value is Cell<any> => value instanceof Cell,
  box: (value: Cell<any>, context: RevivableContext) => {
    const cellId = crypto.randomUUID()
    const unsubscribe = value.subscribe(next => {
      context.sendMessage({ type: 'cell-set', remoteUuid: context.remoteUuid, cellId, value: recursiveBox(next, context) })
    })
    onTeardown(context, unsubscribe)
    return { ...BoxBase, type: 'cell' as const, cellId, value: recursiveBox(value.value, context) }
  },
  revive: (boxed: { cellId: string, value: Capable }, context: RevivableContext) => {
    const revived = new Cell(recursiveRevive(boxed.value, context))
    context.eventTarget.addEventListener('message', (event: CustomEvent<{ type: string }>) => {
      if (!isCellSet(event.detail) || event.detail.cellId !== boxed.cellId) return
      revived.set(recursiveRevive(event.detail.value, context))
    })
    return revived
  }
} as const satisfies RevivableModule
export const withCell = (defaults: DefaultRevivableModules) => [cell, ...defaults] as const
// @filename: worker.ts
// ---cut---
import { expose } from 'osra'
import { Cell, withCell } from './cell'

const temperature = new Cell(20)
const payload = {
  temperature,
  bump: (by: number) => temperature.set(temperature.value + by)
}
export type Payload = typeof payload

expose(payload, { transport: globalThis, revivableModules: withCell })
```

```ts twoslash title="main.ts"
// @filename: cell.ts
import type { Capable, DefaultRevivableModules, RevivableContext, RevivableModule } from 'osra'
import { BoxBase, onTeardown, recursiveBox, recursiveRevive } from 'osra'
export class Cell<T> {
  #value: T
  #listeners = new Set<(value: T) => void>()
  constructor(value: T) { this.#value = value }
  get value() { return this.#value }
  set(value: T) {
    this.#value = value
    for (const listener of this.#listeners) listener(value)
  }
  subscribe(listener: (value: T) => void) {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }
}
type CellSet = { type: 'cell-set', cellId: string, value: Capable }
const isCellSet = (message: { type: string }): message is CellSet => message.type === 'cell-set'
export const cell = {
  type: 'cell' as const,
  objectsOnly: true,
  isType: (value: unknown): value is Cell<any> => value instanceof Cell,
  box: (value: Cell<any>, context: RevivableContext) => {
    const cellId = crypto.randomUUID()
    const unsubscribe = value.subscribe(next => {
      context.sendMessage({ type: 'cell-set', remoteUuid: context.remoteUuid, cellId, value: recursiveBox(next, context) })
    })
    onTeardown(context, unsubscribe)
    return { ...BoxBase, type: 'cell' as const, cellId, value: recursiveBox(value.value, context) }
  },
  revive: (boxed: { cellId: string, value: Capable }, context: RevivableContext) => {
    const revived = new Cell(recursiveRevive(boxed.value, context))
    context.eventTarget.addEventListener('message', (event: CustomEvent<{ type: string }>) => {
      if (!isCellSet(event.detail) || event.detail.cellId !== boxed.cellId) return
      revived.set(recursiveRevive(event.detail.value, context))
    })
    return revived
  }
} as const satisfies RevivableModule
export const withCell = (defaults: DefaultRevivableModules) => [cell, ...defaults] as const
// @filename: worker.ts
import { expose } from 'osra'
import { Cell, withCell } from './cell'
const temperature = new Cell(20)
const payload = {
  temperature,
  bump: (by: number) => temperature.set(temperature.value + by)
}
export type Payload = typeof payload
expose(payload, { transport: globalThis, revivableModules: withCell })
// @filename: main.ts
declare const worker: Worker
// ---cut---
import type { Payload } from './worker'
import { expose } from 'osra'
import { withCell } from './cell'

const { temperature, bump } = await expose<Payload, ReturnType<typeof withCell>>(
  {},
  { transport: worker, revivableModules: withCell }
)

temperature.value // 20
temperature.subscribe(value => console.log(value))

await bump(5) // logs 25, and temperature.value is now 25
```

Two optional module fields exist to support this pattern:

- `init(context)` runs once per connection when it starts, before the first value is boxed, in the order of the module list. It is the place to set up per connection state and attach a single `eventTarget` listener, instead of one per revived value like above.
- `Messages` declares, at the type level, the message variants your module sends, so that `Message<YourModules>` includes them. Every custom message must carry a literal `type` string and the `remoteUuid` of the connection.

If you want to go further, the built-in modules in [`src/revivables/`](https://github.com/Banou26/osra/tree/main/src/revivables) are the reference implementations, with `message-port.ts` being the canonical example of the full pattern.
