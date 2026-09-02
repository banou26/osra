import type {
  Capable, Structurable, Jsonable, Remote,
  RevivableModule, RevivableContext, BoxBase,
  DeepReplaceWithBox, ReplaceWithBox,
} from '../../src/index'
import type { BoxedMap } from '../../src/revivables/map'
import type { BoxedSet } from '../../src/revivables/set'
import type { DefaultRevivableModule } from '../../src/revivables'

// none of these run at runtime - TypeScript's errors are the test results

type Expect<T extends true> = T
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? true
    : false
type Assignable<From, To> = From extends To ? true : false

type _JsonablePositives = [
  Expect<Assignable<string, Jsonable>>,
  Expect<Assignable<number, Jsonable>>,
  Expect<Assignable<boolean, Jsonable>>,
  Expect<Assignable<null, Jsonable>>,
  Expect<Assignable<{ foo: string }, Jsonable>>,
  Expect<Assignable<string[], Jsonable>>,
]

type _StructurablePositives = [
  Expect<Assignable<bigint, Structurable>>,
  Expect<Assignable<Date, Structurable>>,
  Expect<Assignable<RegExp, Structurable>>,
  Expect<Assignable<File, Structurable>>,
  Expect<Assignable<ArrayBuffer, Structurable>>,
  Expect<Assignable<Uint8Array, Structurable>>,
  Expect<Assignable<Map<string, number>, Structurable>>,
  Expect<Assignable<Set<number>, Structurable>>,
  Expect<Assignable<undefined, Structurable>>,
]

type _CapablePositives = [
  Expect<Assignable<bigint, Capable>>,
  Expect<Assignable<Promise<number>, Capable>>,
  Expect<Assignable<() => number, Capable>>,
  Expect<Assignable<MessagePort, Capable>>,
  Expect<Assignable<ReadableStream, Capable>>,
  Expect<Assignable<AbortSignal, Capable>>,
  Expect<Assignable<EventTarget, Capable>>,
  Expect<Assignable<Map<string, Promise<bigint>>, Capable>>,
  Expect<Assignable<Set<Date>, Capable>>,
  Expect<Assignable<{ nested: { deeper: { fn: () => Promise<number> } } }, Capable>>,
  Expect<Assignable<Array<Map<string, Promise<number>>>, Capable>>,
]

// any function type IS Capable via the function revivable: the CapableFunction constraint is
// applied at expose() call sites, not on Capable membership in general
type _CapableNegatives = [
  Expect<Equals<WeakMap<object, string> extends Capable ? true : false, false>>,
  Expect<Equals<WeakSet<object> extends Capable ? true : false, false>>,
]

type _CapableSymbol = [
  Expect<Assignable<symbol, Capable>>,
]

type JsonCtx = RevivableContext & { transport: { isJson: true; emit: any; receive: any } }
type CloneCtx = RevivableContext & { transport: typeof window }

type _CapableCloneCtxPositives = [
  Expect<Assignable<Blob, Capable<DefaultRevivableModule[], CloneCtx>>>,
  Expect<Assignable<File, Capable<DefaultRevivableModule[], CloneCtx>>>,
  Expect<Assignable<RegExp, Capable<DefaultRevivableModule[], CloneCtx>>>,
  Expect<Assignable<ImageData, Capable<DefaultRevivableModule[], CloneCtx>>>,
]

type _CapableJsonCtxNegatives = [
  Expect<Equals<RegExp extends Capable<DefaultRevivableModule[], JsonCtx> ? true : false, false>>,
  Expect<Equals<ImageData extends Capable<DefaultRevivableModule[], JsonCtx> ? true : false, false>>,
  Expect<Equals<Blob extends Capable<DefaultRevivableModule[], JsonCtx> ? true : false, false>>,
  Expect<Equals<File extends Capable<DefaultRevivableModule[], JsonCtx> ? true : false, false>>,
]

type _CapableJsonCtxPositives = [
  Expect<Assignable<bigint, Capable<DefaultRevivableModule[], JsonCtx>>>,
  Expect<Assignable<Date, Capable<DefaultRevivableModule[], JsonCtx>>>,
  Expect<Assignable<Map<string, number>, Capable<DefaultRevivableModule[], JsonCtx>>>,
  Expect<Assignable<Set<number>, Capable<DefaultRevivableModule[], JsonCtx>>>,
  Expect<Assignable<Promise<number>, Capable<DefaultRevivableModule[], JsonCtx>>>,
  Expect<Assignable<() => number, Capable<DefaultRevivableModule[], JsonCtx>>>,
  Expect<Assignable<symbol, Capable<DefaultRevivableModule[], JsonCtx>>>,
]

// Function & Promise box-replacement aren't asserted here: TS's inference of `infer B` over a
// generic `box<T>(...)` signature loses the parameter on the way through `FindMatchingBox`

type _ReplaceMap =
  ReplaceWithBox<Map<string, number>, DefaultRevivableModule>
type _CheckMapReplaced = Expect<
  _ReplaceMap extends BoxBase<'map'> ? true : false
>

type _ReplaceSet =
  ReplaceWithBox<Set<number>, DefaultRevivableModule>
type _CheckSetReplaced = Expect<
  _ReplaceSet extends BoxBase<'set'> ? true : false
>

type _ReplaceBigInt =
  ReplaceWithBox<bigint, DefaultRevivableModule>
type _CheckBigIntReplaced = Expect<
  _ReplaceBigInt extends BoxBase<'bigint'> ? true : false
>

type _PlainPassthrough = ReplaceWithBox<{ foo: string }, DefaultRevivableModule>
type _CheckPlainPassthrough = Expect<
  Equals<_PlainPassthrough, { foo: string }>
>

type _DeepReplaceObjMap =
  DeepReplaceWithBox<{ m: Map<string, number>, plain: string }, DefaultRevivableModule>
type _CheckDeepObjMap = Expect<
  _DeepReplaceObjMap extends { m: BoxBase<'map'>, plain: string } ? true : false
>

type _DeepReplaceArrMap =
  DeepReplaceWithBox<Array<Map<string, number>>, DefaultRevivableModule>
type _CheckDeepArrMap = Expect<
  _DeepReplaceArrMap extends Array<BoxBase<'map'>> ? true : false
>

type Point = { x: number; y: number }
type BoxedPoint = BoxBase<'point'> & { x: number; y: number }

const pointModule = {
  type: 'point' as const,
  isType: (value: unknown): value is Point =>
    !!value && typeof value === 'object' && 'x' in value && 'y' in value,
  box: (value: Point, _ctx: RevivableContext): BoxedPoint =>
    ({ __OSRA_BOX__: 'revivable' as const, type: 'point' as const, x: value.x, y: value.y }),
  revive: (value: BoxedPoint, _ctx: RevivableContext): Point =>
    ({ x: value.x, y: value.y }),
} as const satisfies RevivableModule

type _PointTypeLiteral = Expect<Equals<typeof pointModule.type, 'point'>>

export const __types = () => null as unknown as
  | [_JsonablePositives, _StructurablePositives, _CapablePositives, _CapableNegatives, _CapableSymbol]
  | [_CheckMapReplaced, _CheckSetReplaced, _CheckBigIntReplaced]
  | [_CheckPlainPassthrough, _CheckDeepObjMap, _CheckDeepArrMap]
  | [_PointTypeLiteral]

// A Map, a Set and a ReadableStream carry values through the same box/revive path as anything else,
// so their contents come out in remote shape: functions inside them are promise-returning here.
type _RemoteContainers = [
  Expect<Equals<Remote<Map<string, () => number>>, Map<string, () => Promise<number>>>>,
  Expect<Equals<Remote<Set<() => number>>, Set<() => Promise<number>>>>,
  Expect<Equals<Remote<ReadableStream<() => number>>, ReadableStream<() => Promise<number>>>>,
  Expect<Equals<Remote<Map<string, number>>, Map<string, number>>>,
  // written into, not read out of: the chunks you write are local values
  Expect<Equals<Remote<WritableStream<() => number>>, WritableStream<() => number>>>,
]
