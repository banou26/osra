import { expect } from 'chai'

import { sendOsraMessage } from '../../src/utils/transport'
import { OSRA_DEFAULT_KEY, OSRA_KEY } from '../../src/types'
import { expose } from '../../src/index'

// The same guard the browser suite covers against a fake port, here against a REAL runtime.Port.
// Chromium is the only engine this harness can load an extension into; Firefox words the error
// differently ("Attempt to postMessage on disconnected port") and is covered by the fake-port suite.

const announce = () => ({ [OSRA_KEY]: OSRA_DEFAULT_KEY, type: 'announce' }) as never

const freshPort = () => chrome.runtime.connect({ name: `disconnect-probe-${Date.now()}-${Math.random()}` })

// Asserts the PLATFORM still throws before asserting osra absorbs it. If Chromium ever stops throwing,
// this fails loudly and says the guard needs rechecking, rather than passing for the wrong reason.
export const aRealDisconnectedPortStillThrowsOnPostMessage = async () => {
  const port = freshPort()
  port.disconnect()
  let threw: unknown
  try { port.postMessage({ probe: true }) } catch (error) { threw = error }
  expect(threw, 'runtime.Port must still throw on a disconnected send for this guard to be load-bearing')
    .to.be.instanceOf(Error)
  expect(String((threw as Error).message)).to.match(/disconnected port/)
}

export const osraAbsorbsARealDisconnectedPort = async () => {
  const port = freshPort()
  port.disconnect()
  expect(() => sendOsraMessage(port as never, announce())).to.not.throw()
}

// The reported symptom was volume during teardown, so drive it the way a stream would
export const repeatedSendsToARealDisconnectedPortAreQuiet = async () => {
  const port = freshPort()
  port.disconnect()
  expect(() => {
    for (let i = 0; i < 50; i++) sendOsraMessage(port as never, announce())
  }).to.not.throw()
}

// The whole point: an established osra connection whose port dies must not throw out of the send path.
// A pending call cannot resolve after that, so the assertion is about noise, not delivery.
export const anEstablishedConnectionGoesQuietWhenItsPortDies = async () => {
  const port = freshPort()
  const remote = await expose<{ echo: <T>(data: T) => Promise<T> }>({}, {
    transport: { isJson: true, emit: port, receive: port },
  })
  expect(await remote.echo('alive'), 'the connection works before the disconnect').to.equal('alive')

  port.disconnect()
  const uncaught: unknown[] = []
  const onError = (event: ErrorEvent) => uncaught.push(event.error)
  const onRejection = (event: PromiseRejectionEvent) => uncaught.push(event.reason)
  globalThis.addEventListener('error', onError)
  globalThis.addEventListener('unhandledrejection', onRejection)
  try {
    // fire-and-forget: the call can never answer, but it must not throw synchronously or surface uncaught
    const pending = remote.echo('after-disconnect')
    pending.catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 200))
  } finally {
    globalThis.removeEventListener('error', onError)
    globalThis.removeEventListener('unhandledrejection', onRejection)
  }
  const portErrors = uncaught.filter(error => /disconnected port/.test(String((error as Error)?.message ?? error)))
  expect(portErrors, `expected no disconnected-port errors, got ${portErrors.length}`).to.have.length(0)
}
