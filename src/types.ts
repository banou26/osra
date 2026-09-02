import type { ConnectionMessage } from './connections/index.js'
import type { TypedEventTarget } from './utils/typed-event-target.js'
import type { IsJsonOnlyTransport } from './utils/type-guards.js'
import type {
  DefaultRevivableModules, RevivableModule,
  InferMessages, InferRevivables, RevivableContext
} from './revivables/index.js'

export const OSRA_KEY = '__OSRA_KEY__' as const
export const OSRA_DEFAULT_KEY = '__OSRA_DEFAULT_KEY__' as const
export const OSRA_BOX = '__OSRA_BOX__' as const

export type Uuid = `${string}-${string}-${string}-${string}-${string}`

/* `ReadonlyArray` throughout these unions: `expose()` infers its value with a `const` type parameter, so inline array literals arrive as readonly tuples and must stay assignable. */
export type Jsonable =
  | boolean
  | null
  | number
  | string
  | { [key: string]: Jsonable }
  | ReadonlyArray<Jsonable>

export type Structurable =
  | Jsonable
  // not really structureable but here for convenience.
  // A `/** */` here would be a doc comment on the union MEMBER, which makes typedoc render the
  // whole union as a 20 entry "Union Members" wall on the generated reference page.
  | void
  | undefined
  | bigint
  | Date
  | RegExp
  | Blob
  | File
  | FileList
  | ArrayBuffer
  | ArrayBufferView
  | ImageBitmap
  | ImageData
  | { [key: string]: Structurable }
  | ReadonlyArray<Structurable>
  | Map<Structurable, Structurable>
  | Set<Structurable>

/** lib.dom declares some `Transferable` members as EMPTY interfaces
 *  (`MediaSourceHandle` as of TS 5.x/7.x). With no members they structurally
 *  absorb every object type, which would let `WeakMap` & co. slip past the
 *  `Capable` check unnoticed. Drop member-less types from the compile-time
 *  union; runtime transfer of those exotic types is unaffected. */
type NonAbsorbing<T> = T extends unknown ? keyof T extends never ? never : T : never

export type StructurableTransferable =
  | Structurable
  | NonAbsorbing<Transferable>
  | { [key: string]: StructurableTransferable }
  | ReadonlyArray<StructurableTransferable>
  | Map<StructurableTransferable, StructurableTransferable>
  | Set<StructurableTransferable>

/** "Free" types in `Capable` - narrows to `Jsonable` on JSON transports so
 *  user code can't type a `Date`/`File`/etc. that JSON would silently coerce.
 *  Modules that DO support JSON (date, map, set, bigint, …) put their type
 *  back via `InferRevivables`. */
type CapableBase<Ctx extends RevivableContext> =
  IsJsonOnlyTransport<Ctx['transport']> extends true
    ? Jsonable | undefined | void
    : StructurableTransferable

export type Capable<
  TModules extends readonly RevivableModule[] = DefaultRevivableModules,
  Ctx extends RevivableContext = RevivableContext,
> =
  | CapableBase<Ctx>
  | InferRevivables<TModules, Ctx>
  | { [key: string]: Capable<TModules, Ctx> }
  | ReadonlyArray<Capable<TModules, Ctx>>
  | Map<Capable<TModules, Ctx>, Capable<TModules, Ctx>>
  | Set<Capable<TModules, Ctx>>

/** What a value looks like from the far side of the connection: functions
 *  become async (calls cross the wire), containers map recursively,
 *  everything else revives as itself. */
export type Remote<T> =
  T extends (...args: infer P) => infer R ? (...args: P) => Promise<Remote<Awaited<R>>>
  : T extends Promise<infer U> ? Promise<Remote<U>>
  // these three carry values that are boxed and revived like any other, so what you read out of them
  // on this side is the REMOTE shape: a Map of functions hands you promise-returning ones. A
  // WritableStream is the other way round, you write local values into it, so it passes through
  : T extends Map<infer K, infer V> ? Map<Remote<K>, Remote<V>>
  : T extends Set<infer V> ? Set<Remote<V>>
  : T extends ReadableStream<infer C> ? ReadableStream<Remote<C>>
  : T extends
      | Date | Error | RegExp
      | ArrayBuffer | ArrayBufferView | Blob | File | FileList
      | WritableStream | MessagePort | EventTarget
      | Request | Response | Headers
    ? T
  : T extends AsyncIterable<infer U> ? AsyncIterableIterator<Remote<U>>
  : T extends ReadonlyArray<unknown> ? { [K in keyof T]: Remote<T[K]> }
  : T extends object ? { [K in keyof T]: Remote<T[K]> }
  : T

export type MessageFields = {
  type: string
  remoteUuid: Uuid
}

export type MessageBase = {
  [OSRA_KEY]: string
  /** UUID of the client that sent the message */
  uuid: Uuid
  name?: string
}

export type ProtocolMessage =
  | { type: 'announce', remoteUuid?: Uuid }
  | { type: 'close', remoteUuid: Uuid }

export type MessageVariant<
  TModules extends readonly RevivableModule[] = DefaultRevivableModules
> =
  | ProtocolMessage
  | ConnectionMessage<TModules>
  | InferMessages<TModules>

export type Message<
  TModules extends readonly RevivableModule[] = DefaultRevivableModules
> =
  & MessageBase
  & MessageVariant<TModules>

export type MessageEventMap<
  TModules extends readonly RevivableModule[] = DefaultRevivableModules
> = {
  message: CustomEvent<Message<TModules>>
}

export type MessageEventTarget<
  TModules extends readonly RevivableModule[] = DefaultRevivableModules
  > = TypedEventTarget<MessageEventMap<TModules>>
