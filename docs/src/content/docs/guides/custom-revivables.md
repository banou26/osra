---
title: Custom revivables
description: Teach osra how to send a type it does not know, like your own class.
---

Every type osra knows how to [send](/guides/supported-types/) is implemented as a small module: a guard that recognizes the value, a `box` function that flattens it into something the wire can carry, and a `revive` function that rebuilds it on the other side.\
The defaults are an ordered list of those modules, exported as `defaultRevivableModules`, and the `revivableModules` option of `expose()` hands you that list so you can extend it, reorder it, or replace parts of it.

This is also the way to get your own classes across.\
If you try to send an instance of your own class, osra will usually reject it at compile time, because it has no way to rebuild an arbitrary prototype on the other side.\
The exception is a class extending something osra already handles: an `Error` subclass slips through the error module's guard and arrives as a plain `Error`, see [supported types](/guides/supported-types/#errors).\
And even if a plain class went through, structured clone would only keep the instance's own data fields, so it would arrive as a plain object stripped of its methods.\
A custom module fills exactly that gap: you tell osra how to flatten the instance, and how to build a real one back from those fields.

## A module

```ts twoslash
import type { RevivableContext, RevivableModule } from 'osra'
import { BoxBase } from 'osra'

class Point {
  constructor(public x: number, public y: number) {}
  distance() { return Math.hypot(this.x, this.y) }
}

const point = {
  type: 'point' as const,
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
| `init` | Optional. Runs once when a connection starts, see [the context](#the-context). |
| `Messages` | Optional. Declares the custom message types your module sends, see [the context](#the-context). |

One thing to note is that both `box` and `revive` are synchronous by contract.\
Osra runs them inline while it serializes and deserializes messages, so they must return their result directly, never a `Promise`.\
If your type needs to keep communicating after it was sent, the way the built-in function and stream proxies do, that is what [the context](#the-context) is for.

Also keep in mind that whatever `box` returns is sent as it is, osra does not walk into your box looking for more values to convert.\
Plain JSON data like the two numbers above is always safe, but a field holding a `Date`, a function, or another `Point` needs to be boxed by you, see [nested values](#nested-values).

## Using it

`revivableModules` is a function that receives the default module list and returns the list you actually want.\
Prepending your module to the defaults, like below, is the usual shape.

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
import type { RevivableModule } from 'osra'
import { expose } from 'osra'
import { Point, point } from './point'

const withPoint = <TDefaults extends readonly RevivableModule[]>(defaults: TDefaults) =>
  [point, ...defaults] as const

const payload = { scale: (p: Point) => new Point(p.x * 2, p.y * 2) }

expose(payload, { transport, revivableModules: withPoint })

const remote = await expose<typeof payload, ReturnType<typeof withPoint>>(
  {},
  { transport, revivableModules: withPoint }
)

const doubled = await remote.scale(new Point(3, 4))
doubled.distance() // 10, a real Point with its methods
```

On the side that names the peer's type, pass the module list's type as the second type argument, `ReturnType<typeof withPoint>` above.\
That second type argument is what lets the compile time `Capable` check know about your type: TypeScript has no partial inference, so naming `typeof payload` alone resets the module list back to the defaults, and the call site tells you so, just not where you might expect: the error lands on `revivableModules: withPoint`, because the option now expects a function returning the default list, which `withPoint` no longer is.\
The bare `expose(payload, ...)` call needs no type arguments at all, everything is inferred from the options.

One thing to remember is that both sides need the same list.\
The peer needs your `revive` to rebuild the value, and the same `type` string to find the right module; a side that does not know the `type` will hand your code the raw box, a plain object carrying the wire fields, instead of a `Point`.

Note: none of this is tied to structured transports, a custom module works on [JSON transports](/guides/transport-modes/) too, as long as what its `box` produces is JSON safe or [boxed](#nested-values) the rest of the way.

## Ordering

Boxing walks the list front to back and the first `isType` that matches wins.\
Reviving looks the module up by its `type` string instead, so on that side the order does not matter.

This means that putting your module first lets it win over the defaults.\
That is what you want when your class extends something a default already handles, an `Error` subclass for example, so that your module sees the value before the generic error one does and your extra fields survive.

Dropping or replacing a default works the same way, since you receive the whole list and return whatever you like:

```ts twoslash
import type { RevivableModule } from 'osra'
declare const myDate: RevivableModule
// ---cut---
const modules = <T extends readonly RevivableModule[]>(defaults: T) =>
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
This means that any field of your box that itself needs osra's treatment, a function, a stream, another custom class, has to go through the walker explicitly.\
Call `recursiveBox` on it with the context you were handed, and mirror it with `recursiveRevive` on the other side, which is exactly what the built-in `Map`, `Error` and `CustomEvent` modules do for their own fields:

```ts twoslash
import type { RevivableContext } from 'osra'
import { BoxBase, recursiveBox, recursiveRevive } from 'osra'

class Result {
  constructor(public value: unknown, public at: Date) {}
}
// ---cut---
const result = {
  type: 'result' as const,
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

## The context

Both `box` and `revive` receive the connection's context as their second argument:

| Field | |
|---|---|
| `transport` | The normalized transport. Useful as `isJsonOnlyTransport(context.transport)` when your wire format differs per mode. |
| `remoteUuid` | The peer this connection belongs to. |
| `sendMessage` | Sends a message of your own over the connection. |
| `eventTarget` | Where this connection's incoming messages are dispatched. |
| `revivableModules` | The resolved module list of this connection. |

A simple wrapper type like `Point` never needs any of this, but proxies do: every live value osra supports (functions, streams, message ports) is built with exactly these tools.\
The pattern they all follow is that `box` registers some local state and returns a plain descriptor, updates flow through `context.sendMessage`, and a listener on `context.eventTarget` picks them up on the other side.\
Messages arrive there as `CustomEvent`s, with the message itself on `event.detail`.

Two optional module fields exist to support that pattern:

- `init(context)` runs once per connection when it starts, before the first value is boxed, in the order of the module list. It is the place to set up per connection state and attach your `eventTarget` listener.
- `Messages` declares, at the type level, the message variants your module sends. Every custom message must carry a literal `type` string and the `remoteUuid` of the connection.

If you want to write one, the built-in modules in `src/revivables/` are the reference implementations, with `message-port.ts` being the canonical example of the full pattern.
