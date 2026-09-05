import type { Capable, Remote } from './types.js'
import type { DefaultRevivableModules, RevivableContext } from './revivables/index.js'
import type { RevivableModule } from './revivables/index.js'
import type { Connected, Contextual, Exposed, StartConnectionsOptions } from './connections/utils.js'
import type { Context, Transport } from './utils/transport.js'
import type { IsJsonOnlyTransport } from './utils/type-guards.js'
import type {
  BadFieldValue, BadFieldPath, BadFieldParent,
  ErrorMessage, BadValue, Path, ParentObject
} from './utils/capable-check.js'

import { startConnections } from './connections/index.js'

export * from './types.js'
export * from './revivables/index.js'
export * from './connections/index.js'
export * from './utils/index.js'

// named for the revivable context specifically: `ContextOf` is the PUBLIC helper for a connection
// context builder, re-exported from connections/utils, and two of them in one module is a trap
/** Synthetic context so `Capable` can narrow on the inferred transport
 *  without an actual context object at the call site. Only `transport`
 *  matters; the rest is stubbed with the broadest types.
 *  Named for the revivable context specifically: `ContextOf` is the PUBLIC helper for a connection
 *  context builder, re-exported from connections/utils, and two of them in one module is a trap. */
type RevivableContextOf<TTransport extends Transport> = RevivableContext & { transport: TTransport }

// picks between two error texts: when the value fails ONLY because the transport is JSON (it would
// pass under the broad `RevivableContext`, whose transport union resolves to structured-clone
// semantics), blame the transport instead of the value
/** Error text for a failed check. When the value only fails because the
 *  transport is JSON (it would pass under the broad `RevivableContext`,
 *  whose transport union resolves to structured-clone semantics), blame
 *  the transport instead of the value. */
type CapableCheckMessage<
  T,
  TModules extends readonly RevivableModule[],
  Ctx extends RevivableContext,
> =
  IsJsonOnlyTransport<Ctx['transport']> extends true
    ? [T] extends [Capable<TModules, RevivableContext>]
      ? 'Value type is only supported on structured-clone transports, not on JSON transports'
      : 'Value type must resolve to a Capable'
    : 'Value type must resolve to a Capable'

type CapableCheck<
  T,
  TModules extends readonly RevivableModule[] = DefaultRevivableModules,
  Ctx extends RevivableContext = RevivableContext,
> =
  T extends Capable<TModules, Ctx>
    ? T
    : T & {
        [ErrorMessage]: CapableCheckMessage<T, TModules, Ctx>
        [BadValue]: BadFieldValue<T, Capable<TModules, Ctx>>
        [Path]: BadFieldPath<T, Capable<TModules, Ctx>>
        [ParentObject]: BadFieldParent<T, Capable<TModules, Ctx>>
      }

/**
 * Expose a value to whoever connects, and get back what they exposed.
 *
 * Wrap `value` in `context` to build it once per connection, which is what lets one server answer
 * each realm differently (scoped resolvers per app) instead of sharing one object across all of them.
 * A bare function stays a plain exposed endpoint, so the wrapper is what disambiguates the two.
 *
 * The result is both awaitable and async-iterable: awaiting gives the first peer, iterating gives
 * every peer as it connects. Both hand back the same shape.
 *
 * ```ts
 * const remote = await expose(resolvers, { transport })            // the first peer's value
 * for await (const remote of expose(resolvers, { transport })) { } // every peer's value
 * ```
 *
 * `connection` decides what that shape is. Omit it and it is the peer's value, which is what expose
 * has always resolved to. Return whatever a connection should mean instead:
 *
 * ```ts
 * const { value, context } = await expose(resolvers, {
 *   transport,
 *   connection: ({ value, context }) => ({ value, context }),
 * })
 *
 * for await (const peer of expose(resolvers, {
 *   transport,
 *   connection: ({ value, context }) => ({ value, context }),
 * })) {
 *   if (!allowed(peer.context.origin)) peer.context.abort?.()
 * }
 * ```
 *
 * A peer's identity is whatever the transport can observe merged over whatever the caller declared
 * in `context`. Only a window message carries a browser-set origin and source; a MessagePort message
 * carries neither, so a port-based server declares what it learned when it received the port.
 * Observed fields win over declared ones, so a declaration can never spoof a real origin.
 */
export const expose = <
  T = unknown,
  const TModules extends readonly RevivableModule[] = DefaultRevivableModules,
  const TTransport extends Transport = Transport,
  // after TValue, not before it: these are positional, so slotting a new one into the middle
  // silently reassigns every explicit type argument a consumer already wrote
  const TValue = Capable<TModules, RevivableContextOf<TTransport>>,
  TResult = Remote<T>
>(
  // one conditional, not `CapableCheck<...> | Contextual<CapableCheck<...>>`. A union here costs one
  // step in every Capable error (a "not assignable to (T & {...}) | Contextual<...>" line before the
  // one naming the bad field), and it made a union-typed value infer one member at a time and keep
  // only the first. Measured 2026-09-05 on TypeScript 6.0.3 and 7.0.2; scripts/check-error-chain.mjs
  // pins both.
  value: TValue extends Contextual<infer U>
    ? Contextual<CapableCheck<U, TModules, RevivableContextOf<TTransport>>>
    : CapableCheck<TValue, TModules, RevivableContextOf<TTransport>>,
  // intersecting instead of omitting gives `connection` two signatures at once, and its parameter
  // degrades to a union of both
  options: Omit<StartConnectionsOptions<TModules>, 'connection'> & {
    transport: TTransport
    connection?: (connected: Connected<Remote<T>>) => TResult
  }
): Exposed<TResult> =>
  startConnections<Remote<T>, TModules, TResult>(
    value as Capable<TModules> | Contextual<Capable<TModules>>,
    options as StartConnectionsOptions<TModules>
  )
