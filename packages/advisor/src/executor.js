// The native tool executor for advisor children and verifiers, shared by the
// planner boundary (advisor-planner-*, advisor-consult-*) and the verifier
// boundary (advisor-verifier-*).
//
// Why: in a session on the ptc agent preset the PTC executor presents only
// run_code to the model; every other tool is reachable only from inside a
// run_code program. run_code programs are real Node processes, so the guards
// deny run_code to every Advisor child, and such a child could call nothing.
// For a valid child this module mounts the host's native executor plugin on
// the child's own Agent scope, so the child is offered read, grep, glob and
// its scoped tools directly. The mount is presentation only: the guards are
// unchanged, run_code stays denied, and a failed mount never makes a child
// valid or invalid. It only decides whether a run_code call closes the run at
// once (fail fast) instead of letting the child retry until its caps.
//
// Host facts, read in the DSH 0.2.2-rc.3 app archive (node_modules/@deepseek-ai):
// - dsh-tool-executor-ptc/README.md:12 and src/index.ts:39-49: under PTC only
//   run_code is directly callable; src/index.ts:88-92: the run_code transport
//   is kept outside the registered tools.
// - dsh-tools/src/index.ts:142-147: run_code cannot be registered, so
//   tools.get('run_code', agent) is undefined under either executor; :325-367:
//   setExecutor registers in the scope of the calling context, one executor
//   per scope, and the nearest scope of an Agent's scope chain selects it;
//   :345-348: after an executor unloads its scope keeps an unavailable
//   selection until another one is set.
// - dsh-tool-executor-native/src/index.ts:24-35 (lib/index.js:20-31): the
//   plugin is { name: 'native-tool-executor', inject: ['tools'], apply }, and
//   apply calls ctx.tools.setExecutor(new NativeToolExecutor(ctx)).
// - cordis 4.1.0 lib/index.js:1691-1713: ctx.plugin returns a thenable over
//   fiber.await(); :386-391: it can throw synchronously; :582-587, :611-622: a
//   missing injection leaves the fiber inactive (state 0) without an error;
//   :668-692: the plugin body runs one microtask after ctx.plugin returns, and
//   a start error is stored on the fiber (state 3) and rethrown by await().
//
// Host assumptions (not provable from those sources; a live run in a session
// on the ptc preset decides):
// - agent.ctx carries the child's own Agent scope, so the executor the mounted
//   plugin sets is nearer than the preset scope that holds the PTC executor.
// - The child's first model step is assembled after the mount started; if not,
//   that step still offers run_code (see runCodeFailure for the bound).
// - The installation resolves the bare specifier for this package, which lists
//   it in peerDependencies (dsh-app-boot/src/profile-resolution/resolver.ts:243-254,
//   :636-675). Without engines.dsh, DSH checks that peer's range against its
//   own version and skips the bundle on a mismatch (dsh-app-boot/src/
//   plugin-compatibility.ts:51-74, profile.ts:699-700), so the range in
//   package.json is `*`: any narrower range could skip the whole bundle on a
//   DSH version outside it, while a failed import is already survived.

export const NATIVE_EXECUTOR_PACKAGE = '@deepseek-ai/dsh-tool-executor-native'
/** The PTC transport's name (dsh-tools RUN_CODE_NAME). */
export const RUN_CODE = 'run_code'

const MAX_REASON = 300
const PRESENTATION_NOTE = 'presentation only; the guards and the run_code denial are unchanged'
const ACTIVE = 2

// Fiber states of cordis 4.1.0 (lib/index.js:582-587 and the transitions at :629-636, :685-719).
const STATE_NAMES = Object.freeze({
  0: 'inactive (an injection is unavailable)',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: 'disposed',
  5: 'unloading',
})

/** A message for any thrown value, cut to MAX_REASON characters; never throws. */
function describe(error) {
  let text
  try {
    text = error instanceof Error ? String(error.message) : String(error)
  } catch {
    text = 'an unreadable error'
  }
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 1)}…` : text
}

function readState(fiber) {
  try {
    const state = fiber?.state
    return typeof state === 'number' ? state : undefined
  } catch {
    return undefined
  }
}

function stateLabel(state) {
  if (state === undefined) return 'none'
  return `${state} ${STATE_NAMES[state] ?? 'unknown'}`
}

/**
 * Import the native executor plugin. index.host.js calls this once, when the
 * plugin starts, never from a start listener: a start listener is synchronous,
 * and the mount must happen before the child's first prompt. Never throws or
 * rejects.
 * @param {() => unknown} [load] the import; tests hand in a fake
 * @returns {Promise<{ plugin: { name: string, inject: unknown, apply: Function } } | { reason: string }>}
 */
export async function loadNativeExecutor(load = () => import(NATIVE_EXECUTOR_PACKAGE)) {
  let module
  try {
    module = await load()
  } catch (error) {
    return { reason: `${NATIVE_EXECUTOR_PACKAGE} did not load: ${describe(error)}` }
  }
  try {
    const apply = module?.apply
    if (typeof apply !== 'function') return { reason: `${NATIVE_EXECUTOR_PACKAGE} has no apply function` }
    const name = typeof module.name === 'string' && module.name !== '' ? module.name : 'native-tool-executor'
    return { plugin: Object.freeze({ name, inject: module.inject, apply }) }
  } catch (error) {
    return { reason: `${NATIVE_EXECUTOR_PACKAGE} did not load: ${describe(error)}` }
  }
}

/**
 * Mount the loaded native executor on one child's own Agent scope and watch
 * its fiber: the state right after the call and the settlement of the
 * returned thenable. Never throws. Callers mount once per Agent object, for a
 * valid child only, after its guard and before its scoped registrations, and
 * dispose the mount when the child ends, its Agent is disposed, or the plugin
 * unloads.
 * @param {object} agent the child Agent
 * @param {{ plugin: object } | { reason: string } | undefined} loaded what loadNativeExecutor resolved to
 * @param {(level: 'info' | 'warn', line: string) => void} [report] receives
 *   one diagnostic line per mount: the outcome, the fiber state and whether
 *   run_code is a registered tool for the child
 * @returns {{ agent: object, status: 'skipped' | 'failed' | 'pending' | 'active', reason: string | undefined,
 *   disposed: boolean, dispose: () => void }} the mount; status changes when the fiber settles
 */
export function mountNativeExecutor(agent, loaded, report = () => {}) {
  // fiber: the live fiber; lastFiber: the one disposed; graceStep: see runCodeFailure.
  const mount = { agent, status: 'pending', reason: undefined, disposed: false, fiber: undefined, lastFiber: undefined, logged: false, graceStep: undefined }

  const runCodeRegistered = () => {
    try {
      return agent.ctx.tools.get(RUN_CODE, agent) === undefined ? 'no' : 'yes'
    } catch {
      return 'unknown'
    }
  }
  const log = (note) => {
    if (mount.logged) return
    mount.logged = true
    const state = stateLabel(readState(mount.fiber ?? mount.lastFiber))
    const outcome = mount.status === 'active'
      ? `native executor mounted on the child's Agent scope (${PRESENTATION_NOTE})`
      : mount.status === 'pending'
        ? `native executor not confirmed: ${note}`
        : `native executor not mounted: ${mount.reason}`
    try {
      report(mount.status === 'active' ? 'info' : 'warn', `${outcome}; fiber state ${state}; run_code in tools: ${runCodeRegistered()}`)
    } catch { /* a diagnostic must not break the boundary */ }
  }
  const disposeFiber = () => {
    const fiber = mount.fiber
    if (fiber === undefined) return
    mount.fiber = undefined
    mount.lastFiber = fiber
    try {
      const result = fiber.dispose()
      if (typeof result?.catch === 'function') result.catch(() => {})
    } catch { /* already disposed */ }
  }
  const settle = (status, reason) => {
    if (mount.status !== 'pending' || mount.disposed) return
    mount.status = status
    mount.reason = reason
    log() // with the state the fiber settled in
    if (status !== 'active') disposeFiber()
  }
  mount.dispose = () => {
    if (mount.disposed) return
    log('the mount was released before its fiber started')
    mount.disposed = true
    disposeFiber()
  }

  if (loaded === undefined || loaded === null || typeof loaded !== 'object') {
    settle('skipped', 'no native executor plugin was provided')
    return mount
  }
  if (loaded.plugin === undefined) {
    settle('skipped', typeof loaded.reason === 'string' ? loaded.reason : 'no native executor plugin was provided')
    return mount
  }
  let fiber
  try {
    if (typeof agent.ctx.plugin !== 'function') {
      settle('failed', 'the child Agent context has no plugin method')
      return mount
    }
    fiber = agent.ctx.plugin(loaded.plugin)
  } catch (error) {
    settle('failed', `mounting threw: ${describe(error)}`)
    return mount
  }
  mount.fiber = fiber
  const state = readState(fiber)
  if (state === undefined || typeof fiber?.then !== 'function') {
    settle('failed', 'the mount returned no fiber')
    return mount
  }
  // 1 (loading) is the normal state right after ctx.plugin; 0 (inactive) waits
  // for an injection that may never come, and counts as a failure.
  if (state !== 1 && state !== ACTIVE) {
    settle('failed', `the executor fiber is ${stateLabel(state)} right after mounting`)
    return mount
  }
  try {
    fiber.then(() => {
      const after = readState(fiber)
      if (after === ACTIVE) settle('active')
      else settle('failed', `the executor fiber settled as ${stateLabel(after)}`)
    }, (error) => {
      settle('failed', `the executor failed to start: ${describe(error)}`)
    })
  } catch (error) {
    settle('failed', `the executor fiber cannot be watched: ${describe(error)}`)
  }
  return mount
}

/** Whether a native mount is confirmed: its fiber started and the mount is not released. */
export function mountConfirmed(mount) {
  return mount !== undefined && mount.status === 'active' && !mount.disposed
}

/** Why a mount is not confirmed, for a failure reason. */
function mountProblem(mount) {
  if (mount === undefined) return 'no native executor was provided to the Advisor boundary'
  if (mount.disposed) return 'the mount was already released'
  if (mount.status === 'pending') {
    return `the executor fiber has not started yet (state ${stateLabel(readState(mount.fiber))})`
  }
  return mount.reason ?? 'unknown'
}

/**
 * The failure reason for a run_code call by an Advisor child or verifier, or
 * undefined when the call is only denied. The caller denies run_code in every
 * case; this only decides whether the run is closed now.
 *
 * Without a confirmed mount the run is closed at the first run_code call. With
 * one, the run_code calls of one model step are tolerated, because that step
 * may have been assembled before the mount started (the plugin body runs a
 * microtask after ctx.plugin returns); a run_code call of any later step
 * closes the run, since the mount then did not change what the child is
 * offered. A step is identified by its exec.toolSet; a call without one counts
 * as a step of its own, so at most one such call is tolerated.
 * @param {object | undefined} mount the child's mountNativeExecutor() result
 * @param {object} exec the denied run_code execution
 * @param {string} role 'advisor child' or 'advisor verifier'
 */
export function runCodeFailure(mount, exec, role) {
  const remedy = 'run the Advisor from a session on the standard or cordis agent preset'
  if (!mountConfirmed(mount)) {
    return `run_code was requested: this session uses the PTC executor and the native executor could not be mounted for the ${role} (${mountProblem(mount)}); ${remedy}`
  }
  let step
  try {
    step = exec?.toolSet
  } catch {
    step = undefined
  }
  if (step === undefined || step === null || typeof step !== 'object') step = Symbol('a run_code call without a step')
  if (mount.graceStep === undefined) {
    mount.graceStep = step
    return undefined
  }
  if (mount.graceStep === step) return undefined
  return `run_code was requested again after the native executor was mounted for the ${role}: this session uses the PTC executor and the mount did not change the tools it is offered; ${remedy}`
}
