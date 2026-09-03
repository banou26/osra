import type { Transport } from '../../src'
import type { Message } from '../../src/types'
import type { MessageContext } from '../../src/utils/transport'

export type NodeTransportName = 'Node' | 'NodeJSON'

export type NodeTransportEntry = {
  readonly name: NodeTransportName
  readonly factory: () => Transport
  /** Iteration count for the memory leak tests on this transport. */
  readonly memoryIterations: number
  /** Allowed heap growth (bytes) before a memory test fails. */
  readonly memoryThreshold: number
}

/** A loopback with the browser suite's `window` semantics: every `expose()` on it hears every
 *  message, its own included, and osra's uuid addressing pairs the two ends. Built on a
 *  MessageChannel so a transfer list is honoured and delivery is a task, as postMessage's is. The
 *  ports are unref'd so a test that leaves a connection open cannot keep the process alive. */
const loopback = () => {
  const { port1, port2 } = new MessageChannel()
  // node's MessagePort has unref(); the DOM lib the tests compile against does not know it
  for (const port of [port1, port2]) (port as unknown as { unref(): void }).unref()
  port2.start()
  return { port1, port2 }
}

const structuredLoopback = (): Transport => {
  const { port1, port2 } = loopback()
  return {
    emit: (message: Message, transferables?: Transferable[]) => {
      port1.postMessage(message, transferables ?? [])
    },
    receive: (listener: (message: Message, context: MessageContext) => void) => {
      port2.addEventListener('message', event => listener((event as MessageEvent).data as Message, {}))
    },
  }
}

const jsonLoopback = (): Transport => {
  const { port1, port2 } = loopback()
  return {
    isJson: true,
    emit: (message: Message) => {
      port1.postMessage(JSON.stringify(message))
    },
    receive: (listener: (message: Message, context: MessageContext) => void) => {
      port2.addEventListener('message', event =>
        listener(JSON.parse((event as MessageEvent).data as string) as Message, {}))
    },
  }
}

export const nodeTransports: readonly NodeTransportEntry[] = [
  {
    name: 'Node',
    factory: structuredLoopback,
    memoryIterations: 20_000,
    // process.memoryUsage().heapUsed is a coarser instrument than the browser's CDP heap size, and a
    // shared CI runner is noisier than a quiet desktop: the heaviest test grew 0.05 MB locally and
    // 1.25 MB on a GitHub runner, which failed a 1 MB gate. Measured 2026-09-04, the same test
    // retaining one small object per iteration grows 3.3 MB on top of whatever the run's noise is, so
    // this still gates a real leak with room either side.
    memoryThreshold: 2_500_000,
  },
  {
    name: 'NodeJSON',
    factory: jsonLoopback,
    memoryIterations: 2_500,
    memoryThreshold: 1_600_000,
  },
]
