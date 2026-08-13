/** Per-connection teardown registry. Revivables register cleanup for state
 *  tied to a connection (pending RPC settlements, port routing, caches);
 *  the connection layer runs it on protocol close or unregisterSignal abort.
 *  Registering against an already-torn-down scope runs the callback
 *  immediately so late registrations fail fast instead of leaking. */
const registries = new WeakMap<WeakKey, Set<() => void>>()
const tornDown = new WeakSet<WeakKey>()

export const onTeardown = (scope: WeakKey, fn: () => void): (() => void) => {
  if (tornDown.has(scope)) {
    fn()
    return () => {}
  }
  let set = registries.get(scope)
  if (!set) registries.set(scope, set = new Set())
  set.add(fn)
  return () => set.delete(fn)
}

/** Whether a scope's teardown has already run. Callers use this to REFUSE work rather than start it:
 *  `onTeardown` against a dead scope runs the callback immediately, which is a footgun inside an
 *  initializer, and anything registered afterwards is state no teardown will ever visit again. */
export const isTornDown = (scope: WeakKey): boolean => tornDown.has(scope)

export const runTeardown = (scope: WeakKey): void => {
  if (tornDown.has(scope)) return
  tornDown.add(scope)
  const set = registries.get(scope)
  if (!set) return
  registries.delete(scope)
  for (const fn of set) {
    try { fn() } catch { }
  }
}
