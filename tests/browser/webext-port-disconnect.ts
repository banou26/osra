import { expect } from 'chai'

import { sendOsraMessage } from '../../src/utils/transport'
import { OSRA_DEFAULT_KEY, OSRA_KEY } from '../../src/types'

// A WebExtension port throws on send once disconnected. These run in all three engines against a fake port,
// because the one engine that produces the Firefox wording cannot be driven with a real extension here, and
// the extension harness (Chromium only) covers the real runtime.Port from the other side.

// isWebExtensionPort only probes name/disconnect/postMessage when it is not asked for a connect port
const makePort = (postMessage: (message: unknown) => void) => {
  const sent: unknown[] = []
  return {
    sent,
    calls: () => sent.length,
    port: {
      name: 'fake',
      disconnect: () => {},
      postMessage: (message: unknown) => { sent.push(message); postMessage(message) },
    },
  }
}

const message = { [OSRA_KEY]: OSRA_DEFAULT_KEY, type: 'announce' } as never

const firefoxError = () => new Error('Attempt to postMessage on disconnected port')
const chromiumError = () => new Error('Attempting to use a disconnected port object')

export const firefoxDisconnectIsSwallowed = async () => {
  const { port } = makePort(() => { throw firefoxError() })
  expect(() => sendOsraMessage(port as never, message)).to.not.throw()
}

export const chromiumDisconnectIsSwallowed = async () => {
  const { port } = makePort(() => { throw chromiumError() })
  expect(() => sendOsraMessage(port as never, message)).to.not.throw()
}

// The guard must not become a blanket catch: a message that cannot be serialized is a real bug
export const otherErrorsStillPropagate = async () => {
  const { port } = makePort(() => { throw new DOMException('cyclic object value', 'DataCloneError') })
  expect(() => sendOsraMessage(port as never, message)).to.throw(/cyclic object value/)
}

export const nonErrorThrowsStillPropagate = async () => {
  const { port } = makePort(() => { throw 'some string' })
  expect(() => sendOsraMessage(port as never, message)).to.throw()
}

// The reported symptom was volume ("a LOT"), so one swallow per message is not enough: after the first
// disconnect the port must stop being spoken to at all.
export const aDisconnectedPortIsNotRetried = async () => {
  const probe = makePort(() => { throw firefoxError() })
  for (let i = 0; i < 20; i++) sendOsraMessage(probe.port as never, message)
  expect(probe.calls(), 'only the send that discovered the disconnect reaches the port').to.equal(1)
}

// Remembering a dead port must not deafen a healthy one
export const otherPortsKeepWorking = async () => {
  const dead = makePort(() => { throw firefoxError() })
  const live = makePort(() => {})
  sendOsraMessage(dead.port as never, message)
  sendOsraMessage(live.port as never, message)
  sendOsraMessage(live.port as never, message)
  expect(dead.calls()).to.equal(1)
  expect(live.calls(), 'a healthy port is untouched by another port disconnecting').to.equal(2)
}

// A port that throws only once is still dead; osra must not keep probing it back to life
export const aPortThatThrowsOnceStaysClosed = async () => {
  let first = true
  const probe = makePort(() => {
    if (!first) return
    first = false
    throw firefoxError()
  })
  sendOsraMessage(probe.port as never, message)
  sendOsraMessage(probe.port as never, message)
  expect(probe.calls()).to.equal(1)
}

// Guard against the match being so loose it eats unrelated failures that merely mention a port
export const anUnrelatedPortErrorStillPropagates = async () => {
  const { port } = makePort(() => { throw new Error('failed to bind port 3000') })
  expect(() => sendOsraMessage(port as never, message)).to.throw(/failed to bind port 3000/)
}
