import { expect } from 'chai'

import {
  isJsonOnlyTransport,
  isEmitJsonOnlyTransport,
  isReceiveJsonOnlyTransport,
  isWebExtensionRuntime,
  isWebExtensionPort,
  isWindow,
} from '../../src/utils/type-guards'
import { normalizeTransport } from '../../src/connections/utils'
import { defaultRevivableModules } from '../../src/revivables/index'

// Mimics a cross-origin WindowProxy: any non-whitelisted access, including the `in` operator, throws SecurityError
const crossOriginWindowMock = (): Window => {
  const allowed = new Set(['window', 'self', 'closed', 'close', 'postMessage', 'parent', 'top'])
  const proxy: unknown = new Proxy({}, {
    has: (_t, prop) => {
      if (allowed.has(prop as string)) return true
      throw new DOMException('Blocked a frame from accessing a cross-origin frame.', 'SecurityError')
    },
    get: (_t, prop) => {
      if (prop === 'window' || prop === 'self') return proxy
      if (prop === 'closed') return false
      if (prop === 'close' || prop === 'postMessage') return () => {}
      throw new DOMException('Blocked a frame from accessing a cross-origin frame.', 'SecurityError')
    },
  })
  return proxy as Window
}

// The page's own window where there is one. Node has no window global, so it gets an object with the
// same shape: `window` pointing back at itself, which is the probe isWindow makes first
const sameOriginWindowMock = (): Window => {
  const mock: Record<string, unknown> = { closed: false, close: () => {}, postMessage: () => {} }
  mock.window = mock
  mock.self = mock
  return mock as unknown as Window
}
const sameOriginWindow: Window = typeof window !== 'undefined' ? window : sameOriginWindowMock()

export const windowIsNotJsonOnly = () => {
  expect(isJsonOnlyTransport(sameOriginWindow)).to.equal(false)
}

export const wrappedWindowTransportIsNotJsonOnly = () => {
  const transport = { isJson: false, emit: sameOriginWindow, receive: sameOriginWindow }
  expect(isJsonOnlyTransport(transport as any)).to.equal(false)
}

export const wrappedWindowTransportIsNotEmitJsonOnly = () => {
  const transport = { isJson: false, emit: sameOriginWindow, receive: sameOriginWindow }
  expect(isEmitJsonOnlyTransport(transport)).to.equal(false)
}

export const wrappedWindowTransportIsNotReceiveJsonOnly = () => {
  const transport = { isJson: false, emit: sameOriginWindow, receive: sameOriginWindow }
  expect(isReceiveJsonOnlyTransport(transport)).to.equal(false)
}

export const plainObjectIsNotWebExtensionRuntime = () => {
  expect(isWebExtensionRuntime({})).to.equal(false)
  expect(isWebExtensionRuntime({ foo: 'bar' })).to.equal(false)
  expect(isWebExtensionRuntime({ isJson: false, emit: sameOriginWindow, receive: sameOriginWindow })).to.equal(false)
}

export const plainObjectIsNotWebExtensionPort = () => {
  expect(isWebExtensionPort({})).to.equal(false)
  expect(isWebExtensionPort({ isJson: false, emit: sameOriginWindow, receive: sameOriginWindow })).to.equal(false)
}

export const windowIsWindow = () => {
  expect(isWindow(sameOriginWindow)).to.equal(true)
}

export const plainObjectIsNotWindow = () => {
  expect(isWindow({})).to.equal(false)
  expect(isWindow({ isJson: false, emit: sameOriginWindow, receive: sameOriginWindow })).to.equal(false)
}

export const explicitJsonOnlyTransport = () => {
  const transport = { isJson: true, emit: () => {}, receive: () => {} }
  expect(isJsonOnlyTransport(transport as any)).to.equal(true)
}

export const explicitNonJsonTransportIsNotJsonOnly = () => {
  const transport = { isJson: false, emit: () => {}, receive: () => {} }
  expect(isJsonOnlyTransport(transport as any)).to.equal(false)
}

export const crossOriginWindowIsNotJsonOnly = () => {
  const win = crossOriginWindowMock()
  expect(() => isJsonOnlyTransport(win)).to.not.throw()
  expect(isJsonOnlyTransport(win)).to.equal(false)
  expect(isWindow(win)).to.equal(true)
}

export const normalizeCrossOriginWindowEmitTransport = () => {
  const win = crossOriginWindowMock()
  expect(() => normalizeTransport({ receive: sameOriginWindow, emit: win } as any)).to.not.throw()
  const normalized = normalizeTransport({ receive: sameOriginWindow, emit: win } as any) as any
  expect(normalized.isJson).to.equal(false)
  expect(normalized.emit).to.equal(win)
}

/** `objectsOnly` is a promise a module makes to the walker, which then skips it for every primitive
 *  leaf. A module that breaks the promise would silently stop being offered its own values, so the
 *  flag is checked against the real predicates rather than trusted. */
export const objectsOnlyFlagsAreHonest = async () => {
  const primitives: unknown[] = [
    'hello', '', 0, -0, 42, NaN, Infinity, -Infinity, true, false,
    undefined, null, 10n, Symbol('probe'), Symbol.for('probe'),
  ]
  const flagged = defaultRevivableModules.filter(module => 'objectsOnly' in module && module.objectsOnly)
  expect(flagged.length, 'the default list should have object-only modules to check').to.be.greaterThan(20)

  for (const module of flagged) {
    for (const primitive of primitives) {
      expect(
        module.isType(primitive),
        `${module.type} is flagged objectsOnly but claims ${String(primitive)}`,
      ).to.equal(false)
    }
  }
}
