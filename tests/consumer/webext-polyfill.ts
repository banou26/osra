// osra's WebExtension types are vendored structural shapes (src/utils/webext-types.ts) rather than an
// import of `webextension-polyfill`, because a bare import inside a shipped .d.ts is a dependency the
// consumer may not have. This is what keeps those shapes WIDE enough for the real thing: a consumer
// that does use the polyfill must still be able to hand its runtime, its ports and its events to
// expose(). The @types/chrome direction is covered by tests/extension, which compiles against chrome.*.

import type { Runtime } from 'webextension-polyfill'

import { expose } from '../../build/index.js'
import type { Transport, MessageContext } from '../../build/index.js'

declare const runtime: Runtime.Static
declare const port: Runtime.Port

const runtimeIsATransport: Transport = runtime
const portIsATransport: Transport = port
const onMessageIsATransport: Transport = runtime.onMessage
const onConnectIsATransport: Transport = runtime.onConnect

expose({ ping: async () => 'pong' }, { transport: runtime, key: 'webext-runtime' })
expose({ ping: async () => 'pong' }, { transport: port, key: 'webext-port' })

// the fields consumers actually read off a sender have to survive the vendoring
const readsTheSender = (context: MessageContext) => {
  const id: string | undefined = context.sender?.id
  const url: string | undefined = context.sender?.url
  const tabId: number | undefined = context.sender?.tab?.id
  return [id, url, tabId] as const
}
