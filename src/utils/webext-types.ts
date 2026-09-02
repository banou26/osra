/** Structural stand-ins for the handful of WebExtension shapes osra touches.
 *
 *  Vendored rather than imported from `webextension-polyfill`, because a bare `import type` inside a
 *  SHIPPED .d.ts makes osra's own declarations depend on a package the consumer may not have, and
 *  osra ships no dependencies. 0.6.6 and 0.6.7 did exactly that: `build/utils/transport.d.ts` and
 *  `build/utils/type-guards.d.ts` both imported `webextension-polyfill`, so a consumer without
 *  `@types/webextension-polyfill` got TS2307 under `skipLibCheck: false` and, far worse, a silent
 *  collapse with it on - `WebExtRuntime` became `any`, which made `Transport` `any`, which made
 *  `IsJsonOnlyTransport` true for every transport and degraded the whole `Capable` check.
 *  `npm run check-declaration-imports` is the guard that keeps it from coming back.
 *
 *  Deliberately loose: only the members osra actually calls, typed permissively enough that both
 *  `webextension-polyfill`'s `Runtime.Static` and `@types/chrome`'s `typeof chrome.runtime` stay
 *  assignable, since either can be handed to `expose()` as a transport. No index signatures here,
 *  for the same reason: an interface has no implicit index signature, so adding one to these would
 *  make every real sender and port stop being assignable. `tests/extension` compiles against
 *  @types/chrome and the docs examples compile against webextension-polyfill, which is what keeps
 *  both ends honest. */

/** The three members osra uses on an extension event (`runtime.onMessage`, `port.onDisconnect`, ...). */
export type WebExtEvent<TListener extends (...args: any[]) => any = (...args: any[]) => any> = {
  addListener(listener: TListener, ...rest: any[]): void
  removeListener(listener: TListener): void
  hasListener(listener: TListener): boolean
}

/** Who a message came from, as the browser reported it. osra never builds one, it only hands the
 *  browser's own object through to your code, so the fields are all optional and the engine may
 *  carry more than these. */
export type WebExtSender = {
  id?: string
  url?: string
  origin?: string
  frameId?: number
  documentId?: string
  tlsChannelId?: string
  tab?: {
    id?: number
    url?: string
    title?: string
    windowId?: number
    index?: number
    active?: boolean
  }
}

export type WebExtPort = {
  name: string
  sender?: WebExtSender
  disconnect(): void
  postMessage(message: any): void
  onMessage: WebExtEvent
  onDisconnect: WebExtEvent
}

export type WebExtRuntime = {
  id?: string
  connect(...args: any[]): WebExtPort
  sendMessage(...args: any[]): any
  onMessage: WebExtEvent
  onConnect: WebExtEvent
  onConnectExternal?: WebExtEvent
}

export type WebExtOnConnect = WebExtRuntime['onConnect']
export type WebExtOnMessage = WebExtRuntime['onMessage']

/** The `browser` / `chrome` global, as much of it as osra looks at. */
export type WebExtGlobal = {
  runtime?: WebExtRuntime
}
