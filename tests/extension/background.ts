import type { Resolvers as ContentScriptResolvers } from './content'
import type { ContentAPI } from './types'

import { expose } from '../../src/index'

let contentApi: ContentAPI | null = null
let bgInitiatedContentApi: ContentAPI | null = null
let connectedTabId: number | null = null

const resolvers = {
  echo: async <T>(data: T): Promise<T> => data,
  add: async (a: number, b: number) => a + b,
  math: {
    multiply: async (a: number, b: number) => a * b,
    divide: async (a: number, b: number) => a / b
  },
  createCallback: async () => async () => 42,
  callWithCallback: async (cb: () => number) => cb(),
  getDate: async () => new Date(),
  getError: async () => new Error('Test error'),
  throwError: async (): Promise<never> => { throw new Error('Thrown error') },
  processBuffer: async (data: Uint8Array) => new Uint8Array(data.map(x => x * 2)),
  getBuffer: async () => {
    const buffer = new ArrayBuffer(16)
    new Uint8Array(buffer).forEach((_, i, arr) => arr[i] = i)
    return buffer
  },
  getPromise: async () => Promise.resolve(123),
  getStream: async () => new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]))
      controller.enqueue(new Uint8Array([4, 5, 6]))
      controller.close()
    }
  }),

  bgToContent: {
    getInfo: async () => {
      if (!contentApi) throw new Error('Content not connected')
      return contentApi.getContentInfo()
    },
    process: async (data: string) => {
      if (!contentApi) throw new Error('Content not connected')
      return contentApi.processInContent(data)
    },
    getCallback: async () => {
      if (!contentApi) throw new Error('Content not connected')
      return contentApi.contentCallback()
    },
    getDate: async () => {
      if (!contentApi) throw new Error('Content not connected')
      return contentApi.getContentDate()
    },
    getError: async () => {
      if (!contentApi) throw new Error('Content not connected')
      return contentApi.getContentError()
    },
    throwError: async () => {
      if (!contentApi) throw new Error('Content not connected')
      return contentApi.throwContentError()
    },
    processBuffer: async (data: Uint8Array) => {
      if (!contentApi) throw new Error('Content not connected')
      return contentApi.processContentBuffer(data)
    },
  },

  bgInitiated: {
    connect: async () => {
      if (!connectedTabId) throw new Error('No tab connected yet')
      const port = chrome.tabs.connect(connectedTabId, { name: `bg-to-content-${Date.now()}` })
      bgInitiatedContentApi = await expose<ContentScriptResolvers>(resolvers, {
        transport: { isJson: true, emit: port, receive: port }
      })
      return true
    },
    getInfo: async () => {
      if (!bgInitiatedContentApi) throw new Error('Background-initiated connection not established')
      return bgInitiatedContentApi.getContentInfo()
    },
    process: async (data: string) => {
      if (!bgInitiatedContentApi) throw new Error('Background-initiated connection not established')
      return bgInitiatedContentApi.processInContent(data)
    },
    getCallback: async () => {
      if (!bgInitiatedContentApi) throw new Error('Background-initiated connection not established')
      return bgInitiatedContentApi.contentCallback()
    },
    getDate: async () => {
      if (!bgInitiatedContentApi) throw new Error('Background-initiated connection not established')
      return bgInitiatedContentApi.getContentDate()
    },
    getError: async () => {
      if (!bgInitiatedContentApi) throw new Error('Background-initiated connection not established')
      return bgInitiatedContentApi.getContentError()
    },
    throwError: async () => {
      if (!bgInitiatedContentApi) throw new Error('Background-initiated connection not established')
      return bgInitiatedContentApi.throwContentError()
    },
    processBuffer: async (data: Uint8Array) => {
      if (!bgInitiatedContentApi) throw new Error('Background-initiated connection not established')
      return bgInitiatedContentApi.processContentBuffer(data)
    },
  }
}

export type Resolvers = typeof resolvers

chrome.runtime.onConnect.addListener(async (port) => {
  // Its own branch on purpose: the `content-` arm overwrites the shared `contentApi` every other test reads
  if (port.name.startsWith('disconnect-probe-')) {
    expose<ContentScriptResolvers>(resolvers, {
      transport: { isJson: true, emit: port, receive: port }
    })
    return
  }
  if (port.name.startsWith('content-')) {
    connectedTabId = port.sender?.tab?.id ?? null
    contentApi = await expose<ContentScriptResolvers>(resolvers, {
      transport: { isJson: true, emit: port, receive: port }
    })
  }
})

let runtimeContentApi: ContentAPI | null = null

chrome.runtime.onMessage.addListener(function runtimeInitialListener(message, sender) {
  if (!message?.__OSRA_KEY__ || message.type !== 'announce') return
  if (sender.tab?.id === undefined || sender.frameId === undefined) return

  chrome.runtime.onMessage.removeListener(runtimeInitialListener)

  const tabId = sender.tab.id
  const frameId = sender.frameId

  const buffer: { message: any, sender: any }[] = [{ message, sender }]
  const bufferListener = (msg: any, sdr: any) => { buffer.push({ message: msg, sender: sdr }) }
  chrome.runtime.onMessage.addListener(bufferListener)

  const transport = {
    isJson: true,
    emit: (msg: any) => chrome.tabs.sendMessage(tabId, msg, { frameId }),
    receive: (listener: (message: any, context: any) => void) => {
      chrome.runtime.onMessage.removeListener(bufferListener)
      for (const item of buffer) {
        listener(item.message, { sender: item.sender })
      }
      buffer.length = 0
      chrome.runtime.onMessage.addListener((msg: any, sdr: any) => {
        listener(msg, { sender: sdr })
      })
    }
  }

  expose<ContentScriptResolvers>({
    ...resolvers,
    bgToContent: {
      getInfo: async () => {
        if (!runtimeContentApi) throw new Error('Runtime content not connected')
        return runtimeContentApi.getContentInfo()
      },
      process: async (data: string) => {
        if (!runtimeContentApi) throw new Error('Runtime content not connected')
        return runtimeContentApi.processInContent(data)
      },
      getCallback: async () => {
        if (!runtimeContentApi) throw new Error('Runtime content not connected')
        return runtimeContentApi.contentCallback()
      },
      getDate: async () => {
        if (!runtimeContentApi) throw new Error('Runtime content not connected')
        return runtimeContentApi.getContentDate()
      },
      getError: async () => {
        if (!runtimeContentApi) throw new Error('Runtime content not connected')
        return runtimeContentApi.getContentError()
      },
      throwError: async () => {
        if (!runtimeContentApi) throw new Error('Runtime content not connected')
        return runtimeContentApi.throwContentError()
      },
      processBuffer: async (data: Uint8Array) => {
        if (!runtimeContentApi) throw new Error('Runtime content not connected')
        return runtimeContentApi.processContentBuffer(data)
      },
    },
  }, {
    transport
  }).then(value => { runtimeContentApi = value })
})
