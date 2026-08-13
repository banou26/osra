import { Resolvers as BackgroundResolvers } from './background'

import { expose } from '../../src/index'
import * as contentTests from './content-tests'
import { setApi, setBgInitiatedApi } from './content-tests'
import * as runtimeContentTests from './runtime-content-tests'
import { setApi as setRuntimeApi } from './runtime-content-tests'
import * as portDisconnectTests from './port-disconnect-tests'

const resolvers = {
  getContentInfo: async () => ({ location: window.location.href, timestamp: Date.now() }),
  processInContent: async (data: string) => `content-processed: ${data}`,
  contentCallback: async () => async () => 'from-content-callback',
  getContentDate: async () => new Date(),
  getContentError: async () => new Error('Content error'),
  throwContentError: async (): Promise<never> => { throw new Error('Content thrown') },
  processContentBuffer: async (data: Uint8Array) => new Uint8Array(data.map(x => x + 1)),
}

export type Resolvers = typeof resolvers

const runtimeTransport = {
  isJson: true,
  emit: (message: any) => chrome.runtime.sendMessage(message),
  receive: (listener: (message: any, context: any) => void) => {
    chrome.runtime.onMessage.addListener((message: any, sender: any) => {
      listener(message, { sender })
    })
  }
}

// MUST NOT be top-level await: a manifest content script is loaded as a CLASSIC script, where that is a
// syntax error, so the whole file silently fails to parse and `globalThis.tests` never appears - which
// reads as the harness hanging in beforeAll rather than as a broken build
const main = async () => {
  const port = chrome.runtime.connect({ name: `content-${Date.now()}` })
  setApi(await expose<BackgroundResolvers>(resolvers, {
    transport: { isJson: true, emit: port, receive: port }
  }))

  chrome.runtime.onConnect.addListener(async (port) => {
    if (port.name.startsWith('bg-to-content-')) {
      setBgInitiatedApi(await expose<BackgroundResolvers>(resolvers, {
        transport: { isJson: true, emit: port, receive: port }
      }))
    }
  })

  setRuntimeApi(await expose<BackgroundResolvers>(resolvers, {
    transport: runtimeTransport
  }))

  // last, so its presence means the apis behind it are ready - the spec polls on exactly this
  globalThis.tests = { Content: contentTests, RuntimeContent: runtimeContentTests, PortDisconnect: portDisconnectTests }
}

main()
