import type { RevivableContext } from './utils.js'

import { BoxBase } from './utils.js'
import { box as boxHeaders, revive as reviveHeaders } from './headers.js'
import { box as boxReadableStream, revive as reviveReadableStream } from './readable-stream.js'
import { box as boxAbortSignal, revive as reviveAbortSignal } from './abort-signal.js'

export const type = 'request' as const

/** Never claims a primitive, so the walker can skip this module for primitive leaves. */
export const objectsOnly = true

export const isType = (value: unknown): value is Request =>
  value instanceof Request

export const box = <T extends Request, T2 extends RevivableContext>(
  value: T,
  context: T2
) => ({
  ...BoxBase,
  type,
  method: value.method,
  url: value.url,
  headers: boxHeaders(value.headers, context),
  body: value.body ? boxReadableStream(value.body, context) : null,
  credentials: value.credentials,
  cache: value.cache,
  mode: value.mode,
  redirect: value.redirect,
  referrer: value.referrer,
  referrerPolicy: value.referrerPolicy,
  integrity: value.integrity,
  keepalive: value.keepalive,
  signal: boxAbortSignal(value.signal, context),
})

export const revive = <T extends ReturnType<typeof box>, T2 extends RevivableContext>(
  value: T,
  context: T2
): Request => {
  const headers = reviveHeaders(value.headers, context)

  // Firefox turns `body: null` into a `.body` getter returning `undefined`, so only pass `body` when there's a stream
  const init: RequestInit & { duplex?: 'half' } = {
    method: value.method,
    headers,
    credentials: value.credentials,
    cache: value.cache,
    redirect: value.redirect,
    referrer: value.referrer,
    referrerPolicy: value.referrerPolicy,
    integrity: value.integrity,
    keepalive: value.keepalive,
    signal: reviveAbortSignal(value.signal, context),
  }
  // 'navigate' is not constructible via RequestInit.
  if (value.mode !== 'navigate') init.mode = value.mode
  if (value.body) {
    init.body = reviveReadableStream(value.body, context)
    init.duplex = 'half'
  }

  return new Request(value.url, init)
}

const typeCheck = () => {
  const boxed = box(new Request('https://example.com'), {} as RevivableContext)
  const revived = revive(boxed, {} as RevivableContext)
  const expected: Request = revived
  // @ts-expect-error - not a Request
  const notRequest: string = revived
  // @ts-expect-error - cannot box non-Request
  box('not a request', {} as RevivableContext)
}
