// Compiled against the built declarations with `types: []` and `skipLibCheck: false`, exactly what an npm consumer without our devDependency @types sees.
// If an ambient global (browser, chrome, DedicatedWorkerGlobalScope, …) leaks into the shipped .d.ts, the Transport union collapses to `any` and these assertions fail.

import { expose } from '../../build/index.js'
import type { Transport, Remote, DefaultRevivableModules, ErrorMessage } from '../../build/index.js'

// @ts-expect-error a number must never be assignable to Transport
const notATransport: Transport = 42

// @ts-expect-error expose must reject a non-transport
expose({}, { transport: 42 })

const worker = new Worker('x.js')
const okTransport: Transport = worker

type Api = { add: (a: number, b: number) => number }
const checkRemote = async () => {
  const remote = await expose<Api>({}, { transport: worker })
  const sum: Promise<number> = remote.add(1, 2)
  // @ts-expect-error remote calls are always async - sync access must fail
  const sync: number = remote.add(1, 2)
  return sum
}

// A worker's own global scope is commonly compiled under lib.dom, where it is NOT assignable to Window
const workerSelf: Transport = globalThis
expose({}, { transport: globalThis, key: 'worker-self' })

// lib.dom declares empty-interface Transferable members (MediaSourceHandle) that structurally absorb every object, silencing all of these rejections
// @ts-expect-error WeakMap is not Capable
expose({ ok: async () => 1, cache: new WeakMap() }, { transport: worker, key: 'capable-1' })
// @ts-expect-error a WeakSet nested deep must still be caught
expose({ a: { b: [new WeakSet()] } }, { transport: worker, key: 'capable-2' })

expose({
  fn: async (n: number) => n + 1,
  date: new Date(),
  stream: new ReadableStream(),
  port: new MessageChannel().port1,
  view: new Uint8Array(4),
  map: new Map([['a', 1]]),
  err: new TypeError('x'),
  gen: async function* () { yield 1 },
  list: [1, 2, 3],
  matrix: [[1], [2]],
  nested: { deep: [{ ok: true }] },
}, { transport: worker, key: 'capable-3' })

// a value typed as a union infers as a whole. Until 2026-09-05 the value parameter was a union with its
// Contextual<> wrapper, and TypeScript inferred each member separately and kept only the first
declare const either: { v: string } | { v: number }
expose(either, { transport: worker, key: 'union-value' })

declare const jsonTransport: { isJson: true, emit: Worker, receive: Worker }
// @ts-expect-error File is only supported on structured-clone transports
expose({ foo: new File([], '') }, { transport: jsonTransport, key: 'json-1' })
expose({ foo: new File([], '') }, { transport: worker, key: 'clone-file' })

// `value` accepts the checked value OR its `context()` wrapper, so the branded branch has to be picked out of that union before the message can be read off it
type Branded<T> = Extract<T, { [ErrorMessage]: unknown }>

type JsonFileError = Branded<Parameters<typeof expose<
  unknown, DefaultRevivableModules,
  typeof jsonTransport,
  { foo: File }
>>[0]>
const jsonFileMessage: JsonFileError[typeof ErrorMessage] =
  'Value type is only supported on structured-clone transports, not on JSON transports'
// @ts-expect-error the generic message must not be the one resolved for File
const jsonFileWrong: JsonFileError[typeof ErrorMessage] = 'Value type must resolve to a Capable'

expose({ blob: new Blob(['x']) }, { transport: worker, key: 'clone-blob' })
// @ts-expect-error Blob is only supported on structured-clone transports
expose({ blob: new Blob(['x']) }, { transport: jsonTransport, key: 'json-2' })
type JsonBlobError = Branded<Parameters<typeof expose<
  unknown, DefaultRevivableModules,
  typeof jsonTransport,
  { blob: Blob }
>>[0]>
const jsonBlobMessage: JsonBlobError[typeof ErrorMessage] =
  'Value type is only supported on structured-clone transports, not on JSON transports'

type JsonWeakMapError = Branded<Parameters<typeof expose<
  unknown, DefaultRevivableModules,
  typeof jsonTransport,
  { cache: WeakMap<object, string> }
>>[0]>
const jsonWeakMapMessage: JsonWeakMapError[typeof ErrorMessage] = 'Value type must resolve to a Capable'

void jsonFileMessage; void jsonFileWrong; void jsonBlobMessage; void jsonWeakMapMessage
