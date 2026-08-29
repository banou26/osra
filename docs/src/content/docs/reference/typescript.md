---
title: TypeScript
description: How Remote<T> maps your types across the connection, how the Capable check rejects the rest, and how to read its compile errors.
---

Osra's type system does two jobs, and two types carry almost all of it.\
`Remote<T>` describes what a value looks like from the other side of a connection, so what you get back from `expose()` matches what actually arrives.\
`Capable` is the set of every type osra can send over the transport you passed, and anything outside of it is rejected at compile time.\
`expose()` applies both of them for you, so most of the time you never write either one yourself.

## Remote&lt;T&gt;

When you write `expose<Payload>()`, the value you get back is typed `Remote<Payload>` rather than `Payload` itself.\
The mapping is recursive, and it mostly does one thing: it makes every function asynchronous, because calling one now crosses the wire.

| You have | The peer sees |
|---|---|
| `(...args: P) => R` | `(...args: P) => Promise<Remote<Awaited<R>>>` |
| `Promise<U>` | `Promise<Remote<U>>` |
| `Map`, `Set`, `Date`, `Error`, `RegExp`, `ArrayBuffer` and its views, `Blob`, `File`, `FileList`, `ReadableStream`, `WritableStream`, `MessagePort`, `EventTarget`, `Request`, `Response`, `Headers` | itself |
| `AsyncIterable<U>` | `AsyncIterableIterator<Remote<U>>` |
| Arrays and objects | mapped field by field |
| Everything else | itself |

```ts twoslash title="main.ts"
declare const worker: Worker
import { expose } from 'osra'
// ---cut---
type Api = { add: (a: number, b: number) => number }

const remote = await expose<Api>({}, { transport: worker })

const sum = await remote.add(1, 2) // 3, behind a Promise
```

The rows are tried in the order of the table, and that order matters once: the pass-through row wins over the async iterable one.\
This means that a `ReadableStream` stays a `ReadableStream`, even though the platform makes it async iterable.

One thing to note is that the pass-through row matches structurally, like everything in TypeScript.\
So an `AbortSignal` or a `Worker` both match the `EventTarget` entry and keep their exact declared type, and so does your own class carrying `addEventListener`, `removeEventListener` and `dispatchEvent`.\
Also keep in mind that the type can promise more than the runtime delivers here: an `AbortSignal` really does revive as a live signal, but a `Worker` or an `EventTarget` subclass arrives as the [listener-only façade](/guides/supported-types/#eventtarget), so the methods the type still shows, like `postMessage`, will not exist on the value that arrives.

If you try to send a generic function, its type parameters are lost, because a conditional type cannot carry them across the mapping.\
This means that `<T>(x: T) => T` collapses to `(x: unknown) => Promise<unknown>` on the other side. The function itself still works at runtime, only its typing is flattened.

Note: `Remote<unknown>` is just `unknown`.\
So when you call `expose()` without a type argument, the peer's value comes back as `unknown` and you have to narrow it yourself before calling anything on it.

## Exposed&lt;T&gt; and Connected&lt;T&gt;

`expose()` returns an `Exposed<TResult>`, which is a promise and an async iterable of the same thing:

```ts
type Exposed<TResult> = Promise<TResult> & AsyncIterable<TResult>
```

`TResult` is `Remote<Peer>` by default.\
If you pass the `connection` option, it becomes whatever that function returns instead, and the function receives a `Connected`:

```ts
type Connected<TValue> = { value: TValue, context: Context }

type Context = {
  abort?: () => void
  origin?: string
  source?: MessageEventSource | null
  port?: MessagePort | WebExtPort
  sender?: WebExtSender
}
```

Which fields of `Context` are populated depends on the transport, see [connections](/guides/connections/#what-is-in-the-context).

One thing to note is that naming `Peer` and passing `connection` at the same time does not work.\
TypeScript has no partial type argument inference, so writing `expose<Api>()` resets every later type parameter to its default and the inferred result type is lost.\
If you need both, annotate the function's parameter as `Connected<Remote<Api>>` instead:

```ts twoslash
import { expose } from 'osra'
import type { Connected, Remote } from 'osra'
declare const worker: Worker
type Api = { ping: () => string }
// ---cut---
const { value, context } = await expose({}, {
  transport: worker,
  connection: ({ value, context }: Connected<Remote<Api>>) => ({ value, context })
})

await value.ping() // Promise<string>
```

## The Capable check

`Capable` is built in layers, which you will run into around the API reference:

| Type | What it covers |
|---|---|
| `Jsonable` | Strings, numbers, booleans, `null`, and plain objects and arrays of the same. |
| `Structurable` | `Jsonable` plus what structured clone handles on its own: `Date`, `RegExp`, `Blob`, `File`, `FileList`, `ArrayBuffer` and its views, `ImageBitmap`, `ImageData`, `Map`, `Set`, `bigint`, `undefined`. |
| `StructurableTransferable` | `Structurable` plus the platform's transferable types. |
| `Capable` | That base, plus every type the [revivable modules](/guides/custom-revivables/) contribute, nested in containers of any depth. |

`expose()` checks the value you pass against `Capable`.\
If you try to expose something your transport cannot carry, it will fail at the call site, instead of quietly becoming `{}` at runtime:

```ts twoslash
// @errors: 2345
import { expose } from 'osra'
declare const worker: Worker
// ---cut---
expose({ ok: async () => 1, cache: new WeakMap() }, { transport: worker })
```

### Reading the error

The error is a branded type carrying four symbol-keyed fields, which your editor prints as part of the message:

| Field | What it holds |
|---|---|
| `ErrorMessage` | Why the value was rejected, one of the two messages below. |
| `BadValue` | The first value found that the transport cannot carry, found by deep traversal wherever it is nested. |
| `Path` | The dotted and bracketed path to that value, like `a.b[2]`. An empty string means the root value itself failed. |
| `ParentObject` | The immediate container holding the bad value, or the whole value when the root itself failed. |

So reading the error is mostly reading `Path`: it points at the exact field to fix, even when the `WeakMap` sits three objects deep.

One gap to be aware of is that inside a value typed as a plain array, `T[]`, the traversal cannot descend, so `BadValue` becomes the array itself and `Path` stops at it.\
Tuples are walked element by element and report the exact index.\
And since `expose()` infers its value with a `const` type parameter, inline array literals arrive as tuples and get the precise report, so the coarse one only shows up for values typed as plain arrays elsewhere.

## JSON transports check harder

`Capable` resolves against the transport `expose()` inferred, so the same value can be legal on one channel and rejected on another.\
On a [JSON transport](/guides/transport-modes/), the base of the union narrows down to `Jsonable`, and the modules that only work with structured clone (`Blob`, `File`, and the clonable and transferable host objects) stop contributing their types.\
This means that a value JSON would silently mangle fails at compile time instead:

```ts twoslash
// @errors: 2345
import { expose } from 'osra'
// ---cut---
expose({ foo: new File([], '') }, { transport: new WebSocket('') })
```

The same code with a `Worker` transport compiles.

When a value fails only because of the transport, meaning it would be fine on a structured one, the `ErrorMessage` says so:\
`Value type is only supported on structured-clone transports, not on JSON transports`, instead of the general `Value type must resolve to a Capable`.

Types with a dedicated module that supports both modes, like `Date`, `Map`, `Set`, `bigint`, `ArrayBuffer`, functions and streams, stay legal on JSON. See [supported types](/guides/supported-types/) for the full table.

## Custom types

Registering a [custom revivable](/guides/custom-revivables/) widens `Capable`, as long as you tell the type system about it at the call site:

```ts
expose<PeerApi, ReturnType<typeof withMyType>>(value, {
  transport,
  revivableModules: withMyType
})
```

`revivableModules` is a function receiving the default module list and returning the final one, and its return type is what you pass as the second type argument, so the `Capable` check learns about your types.\
Without that type argument your modules still run at runtime, but `Capable` falls back to the defaults and rejects your type where you wrote it.

Also keep in mind the partial inference rule from above: naming `PeerApi` alone resets the module list parameter to its default, so pass both type arguments or neither.

## Requirements

Osra does not pin a TypeScript version in its `package.json`, but in practice the shipped declarations set the floor.\
They reference `Float16Array`, so your `lib` needs to be recent enough to include it, `esnext` is.\
The library itself is type checked with TypeScript 7, and every example in these docs is checked with TypeScript 5.9, so those are the versions we exercise.

Compile with `strict` on, it is the only configuration we test.\
One thing to note is that you do not need `skipLibCheck`: the declarations are verified clean without it, compiled exactly as an npm consumer sees them.
