import { BoxBase, type RevivableContext } from './utils.js'
import { identity } from './identity.js'
import { box as boxFunction, revive as reviveFunction } from './function.js'
import { trackGc } from '../utils/gc-tracker.js'

export const type = 'eventTarget' as const

/** Never claims a primitive, so the walker can skip this module for primitive leaves. */
export const objectsOnly = true

type ListenerOpts = boolean | { capture?: boolean, once?: boolean, passive?: boolean, signal?: AbortSignal }

export const isType = (value: unknown): value is EventTarget => value instanceof EventTarget

export const box = <T extends EventTarget, T2 extends RevivableContext>(value: T, context: T2) => {
  const added: { eventType: string, listener: EventListener, capture: boolean }[] = []
  const captureOf = (options?: ListenerOpts) =>
    typeof options === 'boolean' ? options : !!options?.capture
  return {
    ...BoxBase,
    type,
    addListener: boxFunction(
      (eventType: string, listener: EventListener, options?: ListenerOpts) => {
        added.push({ eventType, listener, capture: captureOf(options) })
        value.addEventListener(eventType, listener, options)
      },
      context,
    ),
    removeListener: boxFunction(
      (eventType: string, listener: EventListener, options?: ListenerOpts) => {
        const capture = captureOf(options)
        const index = added.findIndex(r =>
          r.eventType === eventType && r.listener === listener && r.capture === capture)
        if (index !== -1) added.splice(index, 1)
        value.removeEventListener(eventType, listener, options)
      },
      context,
    ),
    removeAllListeners: boxFunction(
      () => {
        for (const { eventType, listener, capture } of added.splice(0)) {
          value.removeEventListener(eventType, listener, { capture })
        }
      },
      context,
    ),
  }
}

export type BoxedEventTarget = ReturnType<typeof box>

// Stable EventListener per EventListenerObject so identity() yields the same id on add and remove.
const objectWrappers = new WeakMap<EventListenerObject, EventListener>()
const toListener = (listerObject: EventListenerOrEventListenerObject): EventListener => {
  if (typeof listerObject === 'function') return listerObject
  let listener = objectWrappers.get(listerObject)
  if (!listener) objectWrappers.set(listerObject, listener = (e) => listerObject.handleEvent(e))
  return listener
}

type Reg = { eventType: string, listener: EventListener, capture: boolean, wire: EventListener }

const findReg = (regs: Reg[], eventType: string, listener: EventListener, capture: boolean): Reg | undefined =>
  regs.find(r => r.eventType === eventType && r.listener === listener && r.capture === capture)

export const revive = <T extends BoxedEventTarget, T2 extends RevivableContext>(value: T, context: T2) => {
  const addRpc = reviveFunction(value.addListener, context)
  const removeRpc = reviveFunction(value.removeListener, context)
  const removeAllRpc = reviveFunction(value.removeAllListeners, context)
  // Façade only - events never dispatch through it; the source-side EventTarget owns all semantics.
  const target = new EventTarget()
  const regs: Reg[] = []

  const prune = (reg: Reg) => {
    const index = regs.indexOf(reg)
    if (index !== -1) regs.splice(index, 1)
  }

  Object.defineProperty(target, 'addEventListener', {
    value: (eventType: string, listener: EventListenerOrEventListenerObject | null, options?: ListenerOpts) => {
      if (listener === null) return
      const fn = toListener(listener)
      const capture = typeof options === 'boolean' ? options : !!options?.capture
      if (findReg(regs, eventType, fn, capture)) return
      const once = typeof options === 'object' && !!options?.once
      const wire: EventListener = once
        ? (event) => {
            prune(reg)
            return fn(event)
          }
        : fn
      const reg: Reg = { eventType, listener: fn, capture, wire }
      regs.push(reg)
      const signal = typeof options === 'object' ? options?.signal : undefined
      signal?.addEventListener('abort', () => prune(reg), { once: true })
      addRpc(eventType, identity(wire), options).catch(() => {})
    },
  })

  Object.defineProperty(target, 'removeEventListener', {
    value: (eventType: string, listener: EventListenerOrEventListenerObject | null, options?: ListenerOpts) => {
      if (listener === null) return
      const fn = toListener(listener)
      const capture = typeof options === 'boolean' ? options : !!options?.capture
      const reg = findReg(regs, eventType, fn, capture)
      if (!reg) return
      prune(reg)
      removeRpc(eventType, identity(reg.wire), { capture }).catch(() => {})
    },
  })

  // Cleanup must NOT close over `target`, `regs`, or any user listener - the FR strong-holds it.
  trackGc(target, () => {
    removeAllRpc().catch(() => {})
  })

  return target
}

const typeCheck = () => {
  const r = revive(box(new EventTarget(), {} as RevivableContext), {} as RevivableContext)
  const expected: EventTarget = r
  // @ts-expect-error - not a string
  const notString: string = r
  // @ts-expect-error - cannot box non-EventTarget
  box('not an event target', {} as RevivableContext)
}
