// The rebased engine spec and the failure scenarios against the GENERATED
// engine JS (src/engine) at an rc.3 source checkout (docs/verification.md).
// Optional: the suite runs only when DSH_UPSTREAM_DIR names the rc.3 checkout
// (tag dsh-v0.2.2-rc.3) with its dependencies installed and the native
// session-lock addon in place; otherwise it reports one skipped test and exits 0.
//
//   export PATH="$HOME/.nvm/versions/node/v24.22.3/bin:$PATH"   # Node >= 24.9
//   DSH_UPSTREAM_DIR=/tmp/dsh-rc3-s7 node --test packages/session-search-patched/test/upstream/*.test.mjs
//   # optional third engine, the compiled lib/index.js extracted from the installed app:
//   SSP_RC3_EXTRACT=/tmp/ssp-s4/shipped DSH_UPSTREAM_DIR=... node --test ...
//
// "shipped" is the rc.3 engine source of the checkout (src/index.ts, sha256
// checked against the installed app's copy, vendor/PROVENANCE.md); "generated"
// is src/engine/index.js of this package, loaded in place. Both run on the
// rc.3 cordis, session store and JSONL backend of the checkout (one module
// instance each, asserted by loadUpstream()).
//
// The checkout is only read, except for one scratch folder per vitest run
// (packages/session-query/session-query-sqlite/ssp-upstream-<random>/, removed
// afterwards; `git status` of the checkout is compared before and after). Every
// store is a fresh fs.mkdtemp under os.tmpdir(). HOME, DSH_HOME and the XDG
// roots point at decoy folders for the whole run, and the last test asserts
// that they stayed empty. Nothing here touches a real profile or session store.
//
// Test ids match docs/verification.md: C2 spec, C3 appending session, C4 unknown
// event type, C5 same hits, C6 heap probe smoke, C7 real home.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { installDecoys } from '../helpers/decoys.mjs'
import {
  FILES, GENERATED_DIR, GENERATED_INDEX, IDENTITY_SPEC, PKG_DIR, PROBE_SCRIPT, RC3, ROW_CONFIG, SPEC_SCRATCH_PARENT,
  VENDOR_SPEC, VITEST_CONFIG, assertScratchStorePath, comparisonQueries, forbiddenRoots, instrumentPersistence,
  loadUpstream, makeHeader, mountEngine, mountStore, outcome, realHome, runPaged, sha256File, upstreamSkipReason,
  userEvent, writeComparisonStore,
} from './upstream-lib.mjs'

const RAW = process.env.DSH_UPSTREAM_DIR?.trim() || undefined
const UPSTREAM = RAW !== undefined && fs.existsSync(RAW) ? fs.realpathSync(RAW) : RAW
const SHIPPED_LIB = process.env.SSP_RC3_EXTRACT?.trim() || undefined
const SKIP = upstreamSkipReason(UPSTREAM)

if (SKIP !== undefined) {
  test('generated engine against the rc.3 checkout: spec and failure scenarios (C2-C7)', { skip: SKIP }, () => {})
} else {
  describe('generated engine against the rc.3 checkout', () => {
    /** Every temp folder this run created; removed in after(). */
    const created = []
    let decoys
    let up
    /** The shipped engines this run compares with: the checkout source, plus the app's compiled lib when given. */
    const SHIPPED = SHIPPED_LIB === undefined ? ['shipped'] : ['shipped', 'shippedLib']

    /** A fresh folder under os.tmpdir(), canonical (macOS /var -> /private/var). */
    const fresh = (label) => {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ssp-upstream-${label}-`)))
      created.push(dir)
      return dir
    }

    before(async () => {
      decoys = installDecoys('upstream-decoys')
      up = await loadUpstream(UPSTREAM, SHIPPED_LIB === undefined ? {} : { shippedLib: SHIPPED_LIB })
    })

    after(() => {
      for (const dir of created) fs.rmSync(dir, { recursive: true, force: true })
      decoys?.restore()
    })

    /** Run node with the decoy environment; resolves with exit code, signal and output. */
    function runNode(args, { cwd = PKG_DIR, env = {}, timeoutMs = 240_000 } = {}) {
      return new Promise((resolve) => {
        const child = spawn(process.execPath, args, { cwd, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => { stdout += chunk })
        child.stderr.on('data', (chunk) => { stderr += chunk })
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
        child.on('close', (code, signal) => {
          clearTimeout(timer)
          resolve({ code, signal, stdout, stderr })
        })
      })
    }

    const probeResult = (run) => {
      const line = run.stdout.split('\n').find((text) => text.startsWith('SSP_PROBE_RESULT '))
      return line === undefined ? undefined : JSON.parse(line.slice('SSP_PROBE_RESULT '.length))
    }

    /** `git status` of the checkout without taking the index lock; undefined when git is unavailable. */
    function gitStatus(dir) {
      const run = spawnSync('git', ['--no-optional-locks', '-C', dir, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' })
      return run.status === 0 ? run.stdout : undefined
    }

    // --- C7a: the real DSH home ------------------------------------------------

    test('C7 a store path in the real DSH home is refused before anything inside it is touched', async (t) => {
      const home = realHome()
      const [dshRoot, stateRoot] = forbiddenRoots()
      assert.notEqual(process.env.HOME, home, 'HOME is a decoy during the suite')
      assert.notEqual(process.env.DSH_HOME, dshRoot)
      const links = fresh('c7-links')
      fs.symlinkSync(path.join(dshRoot, 'sessions'), path.join(links, 'to-dsh-sessions'))
      fs.symlinkSync(path.join(links, 'to-dsh-sessions'), path.join(links, 'chain'))
      fs.symlinkSync(home, path.join(links, 'home'))
      fs.symlinkSync('../c7-relative-missing/../..', path.join(links, 'relative'))
      const refused = [
        dshRoot,
        `${dshRoot}${path.sep}`,
        path.join(dshRoot, 'sessions'),
        path.join(dshRoot, 'profiles', 'web', 'sessions'),
        `${home}${path.sep}projects${path.sep}..${path.sep}.dsh${path.sep}sessions`,
        path.join(links, 'to-dsh-sessions'),
        // Lexically this is <links>/elsewhere; through the link it is ~/.dsh/elsewhere.
        `${links}${path.sep}to-dsh-sessions${path.sep}..${path.sep}elsewhere`,
        path.join(links, 'chain', 'nested'),
        path.join(links, 'home', '.dsh', 'sessions'),
        path.join(stateRoot, 'dsh', 'sessions'),
        ...(process.platform === 'darwin' ? [path.join(home, '.DSH', 'sessions'), path.join(home, '.Local', 'State')] : []),
      ]
      // Record every path the guard stats or reads while it refuses.
      const touched = []
      const originals = { lstatSync: fs.lstatSync, readlinkSync: fs.readlinkSync, statSync: fs.statSync, readdirSync: fs.readdirSync, openSync: fs.openSync }
      for (const [name, original] of Object.entries(originals)) {
        fs[name] = function recorded(target, ...rest) {
          touched.push(String(target))
          return original.call(this, target, ...rest)
        }
      }
      const outcomes = []
      try {
        for (const candidate of refused) {
          try {
            assertScratchStorePath(candidate)
            outcomes.push({ candidate, refused: false })
          } catch (error) {
            outcomes.push({ candidate, refused: error.code === 'SSP_FORBIDDEN_STORE_PATH', code: error.code })
          }
        }
      } finally {
        Object.assign(fs, originals)
      }
      const fold = (p) => (process.platform === 'darwin' ? p.toLowerCase() : p)
      const insideForbidden = touched.filter((p) => forbiddenRoots().some((root) => {
        const relative = path.relative(fold(root), fold(path.resolve(p)))
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
      }))

      const accepted = path.join(fresh('c7-ok'), 'sessions')
      const relativeLink = path.join(links, 'relative', 'store')
      const mount = await outcome(mountStore(up, path.join(dshRoot, 'sessions')))
      const probe = await runNode([PROBE_SCRIPT, 'heap', '--upstream', UPSTREAM, '--engine', 'generated', '--store', path.join(dshRoot, 'sessions')], { timeoutMs: 60_000 })
      const probeLink = await runNode([PROBE_SCRIPT, 'matrix', '--upstream', UPSTREAM, '--caps', '256', '--store', path.join(links, 'chain')], { timeoutMs: 60_000 })
      t.diagnostic(JSON.stringify({ C7: { refused: outcomes.length, allRefused: outcomes.every((o) => o.refused), touchedPaths: touched.length, touchedInsideForbidden: insideForbidden.length, mountStore: { ok: mount.ok, code: mount.code }, probe: { exit: probe.code, result: probeResult(probe)?.code }, probeViaLink: { exit: probeLink.code, result: probeResult(probeLink)?.code } } }))

      for (const entry of outcomes) assert.ok(entry.refused, `refused: ${entry.candidate}`)
      assert.deepEqual(insideForbidden, [], 'nothing inside ~/.dsh or ~/.local/state was stat\'ed or read')
      assert.equal(assertScratchStorePath(accepted), accepted, 'a mkdtemp folder is accepted')
      assert.equal(typeof assertScratchStorePath(relativeLink), 'string', 'a link that resolves outside the forbidden roots is accepted')
      assert.equal(mount.ok, false)
      assert.equal(mount.code, 'SSP_FORBIDDEN_STORE_PATH', 'mountStore refuses before a context exists')
      assert.equal(probe.code, 2)
      assert.equal(probeResult(probe)?.code, 'SSP_FORBIDDEN_STORE_PATH')
      assert.equal(probeLink.code, 2, 'the probe refuses a symbolic link into ~/.dsh')
      assert.equal(probeResult(probeLink)?.code, 'SSP_FORBIDDEN_STORE_PATH')
    })

    // --- C2: the rebased spec against the generated JS -----------------------------

    async function runSpec(engineFile) {
      const scratch = path.join(UPSTREAM, SPEC_SCRATCH_PARENT, `ssp-upstream-${randomBytes(4).toString('hex')}`)
      const report = path.join(fresh('c2-report'), 'report.json')
      fs.mkdirSync(scratch)
      try {
        fs.writeFileSync(path.join(scratch, 'vitest.config.ts'), VITEST_CONFIG)
        fs.writeFileSync(path.join(scratch, 'identity.spec.ts'), IDENTITY_SPEC)
        fs.copyFileSync(VENDOR_SPEC, path.join(scratch, 'sqlite.spec.ts'))
        assert.equal(sha256File(path.join(scratch, 'sqlite.spec.ts')), RC3.vendorSpec)
        const run = await runNode([
          path.join(UPSTREAM, FILES.vitest), 'run', '--config', path.join(scratch, 'vitest.config.ts'),
          '--reporter=default', '--reporter=json', `--outputFile.json=${report}`,
        ], { cwd: UPSTREAM, env: { SSP_ENGINE_UNDER_TEST: engineFile }, timeoutMs: 280_000 })
        const json = JSON.parse(fs.readFileSync(report, 'utf8'))
        const files = {}
        for (const file of json.testResults) {
          const counts = { passed: 0, failed: 0, skipped: 0 }
          for (const result of file.assertionResults) {
            if (result.status === 'passed') counts.passed += 1
            else if (result.status === 'failed') counts.failed += 1
            else counts.skipped += 1
          }
          files[path.basename(file.name)] = { ...counts, failedTitles: file.assertionResults.filter((r) => r.status === 'failed').map((r) => r.title) }
        }
        const tail = run.stdout.split('\n').filter((line) => /Test Files|Tests |✓|×/.test(line)).slice(-8).map((line) => line.trim())
        return { exit: run.code, totals: { passed: json.numPassedTests, failed: json.numFailedTests, pending: json.numPendingTests, total: json.numTotalTests }, files, tail }
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true })
      }
    }

    test('C2 the rebased spec passes against the generated engine JS inside the rc.3 checkout (vitest)', { timeout: 600_000 }, async (t) => {
      assert.equal(sha256File(VENDOR_SPEC), RC3.vendorSpec, 'vendor/tests/sqlite.spec.ts is the rebased spec of PROVENANCE.md')
      const manifest = JSON.parse(fs.readFileSync(path.join(GENERATED_DIR, 'manifest.json'), 'utf8'))
      for (const [file, hash] of Object.entries(manifest.outputs)) assert.equal(sha256File(path.join(PKG_DIR, file)), hash, `${file} matches its manifest`)
      const statusBefore = gitStatus(UPSTREAM)
      const generated = await runSpec(GENERATED_INDEX)
      // Control: the same harness on the pristine rc.3 engine source must fail the patch's tests.
      const control = await runSpec(path.join(UPSTREAM, FILES.shippedEngine))
      const statusAfter = gitStatus(UPSTREAM)
      t.diagnostic(JSON.stringify({ C2: { generated: { ...generated, files: Object.fromEntries(Object.entries(generated.files).map(([k, v]) => [k, { passed: v.passed, failed: v.failed, skipped: v.skipped }])) }, control: { exit: control.exit, totals: control.totals, failedTitles: Object.values(control.files).flatMap((f) => f.failedTitles) } } }))

      assert.equal(generated.exit, 0)
      assert.deepEqual(
        { identity: generated.files['identity.spec.ts'], sqlite: generated.files['sqlite.spec.ts'] },
        { identity: { passed: 1, failed: 0, skipped: 0, failedTitles: [] }, sqlite: { passed: 92, failed: 0, skipped: 0, failedTitles: [] } },
      )
      assert.notEqual(control.exit, 0)
      assert.equal(control.files['identity.spec.ts'].failed, 1, 'the identity spec tells the engines apart')
      assert.deepEqual([control.files['sqlite.spec.ts'].passed, control.files['sqlite.spec.ts'].failed], [77, 15], 'the spec detects the patch (S2 control: 15 failed / 87 passed incl. query.spec)')
      if (statusBefore !== undefined) assert.equal(statusAfter, statusBefore, 'the checkout is left as it was')
    })

    // --- C3: the appending session ---------------------------------------------------

    /**
     * `sessionCount` stored sessions in a real rc.3 JSONL backend (zstd). Session
     * 0 is the appending session: its writer stays open; with `liveOwned` it is
     * also live in `ctx.sessions` and the backend routes its events to that
     * writer, as the host does for the session the user is working in. While
     * `appendDuring` is set, session 0 appends one event after every
     * `appendEvery`-th whole-log read the engine makes: an append rate that is
     * proportional to the indexing work, like a session that keeps streaming
     * while a cold index is built.
     */
    async function appendingFixture(engineName, sessionCount, { liveOwned, appendEvery }) {
      const root = path.join(fresh('c3'), 'sessions')
      const store = await mountStore(up, root)
      const { ctx, P } = store
      const metas = Array.from({ length: sessionCount }, (_, index) => makeHeader(up, `app-${sessionCount}-${String(index).padStart(2, '0')}`, { createdAt: 10 + index }))
      const first = metas[0]
      const live = liveOwned
        ? ctx.sessions.create(first.id, { seed: [userEvent(up, 0, 1, 'live needle')], meta: { createdAt: first.createdAt } })
        : undefined
      const writer = await P.create(first)
      await writer.append(live === undefined ? [userEvent(up, 0, 1, `stored needle ${first.id}`)] : structuredClone([...live.snapshotEvents()]))
      await writer.flush()
      for (const meta of metas.slice(1)) {
        const handle = await P.create(meta)
        await handle.append([userEvent(up, 0, 1, `stored needle ${meta.id}`)])
        await handle.close()
      }
      let nextSeq = 1
      let appends = 0
      let appending = false
      const append = async () => {
        appends += 1
        if (live === undefined) {
          await writer.append([userEvent(up, nextSeq, nextSeq + 1, `appended needle ${nextSeq}`)])
          await writer.flush()
          nextSeq += 1
          return
        }
        live.append('user/message', up.llm.createUserMessage({ content: [{ type: 'text', text: 'live appended needle' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
        assert.equal(await ctx.sessions.flush(live), true)
      }
      const counter = instrumentPersistence(P, {
        onWholeRead: async (_id, reads) => {
          if (appending && reads % appendEvery === 0) await append()
        },
      })
      const fiber = ctx.plugin(up.engines[engineName].Engine, { ...ROW_CONFIG })
      await fiber
      return {
        firstId: String(first.id),
        ids: metas.map((meta) => String(meta.id)),
        append,
        async measure({ appendDuring = false } = {}) {
          counter.reset()
          appends = 0
          appending = appendDuring
          try {
            const result = await outcome(ctx.sessionQuery.searchSessions({ query: 'needle', limit: 1 }))
            return { ok: result.ok, ...(result.ok ? {} : { code: result.code }), ...counter.snapshot(), appends }
          } finally {
            appending = false
          }
        },
        async dispose() {
          await fiber.dispose()
          await writer.close()
          await store.dispose()
        },
      }
    }

    async function appendingSequence(engineName, size, options) {
      const fixture = await appendingFixture(engineName, size, options)
      try {
        const coldWhileAppending = await fixture.measure({ appendDuring: true })
        const next = await fixture.measure()
        await fixture.append()
        const appendedBetween = await fixture.measure()
        const quiet = await fixture.measure()
        return { firstId: fixture.firstId, ids: fixture.ids, coldWhileAppending, next, appendedBetween, quiet }
      } finally {
        await fixture.dispose()
      }
    }

    const APPEND_EVERY = 4
    const SIZES = [8, 32]

    for (const liveOwned of [false, true]) {
      const variant = liveOwned ? 'live-owned appending session' : 'stored appending session'
      test(`C3 ${variant}: shipped fails with SESSION_QUERY_PERSISTENCE_FAILED, generated succeeds and re-reads only the changed session`, { timeout: 120_000 }, async (t) => {
        const table = []
        for (const size of SIZES) {
          const cold = liveOwned ? size - 1 : size
          const generated = await appendingSequence('generated', size, { liveOwned, appendEvery: APPEND_EVERY })
          const shipped = {}
          for (const name of SHIPPED) shipped[name] = await appendingSequence(name, size, { liveOwned, appendEvery: APPEND_EVERY })
          const strip = ({ readsById, ...rest }) => rest
          table.push({
            size,
            generated: Object.fromEntries(['coldWhileAppending', 'next', 'appendedBetween', 'quiet'].map((k) => [k, strip(generated[k])])),
            ...Object.fromEntries(Object.entries(shipped).map(([name, run]) => [name, Object.fromEntries(['coldWhileAppending', 'next', 'appendedBetween', 'quiet'].map((k) => [k, strip(run[k])]))])),
          })

          // Generated: the first attempt commits every log it read; the retry re-reads only session 0.
          const expectedColdReads = Object.fromEntries(generated.ids.filter((id) => !(liveOwned && id === generated.firstId)).map((id) => [id, id === generated.firstId ? 2 : 1]))
          assert.deepEqual(generated.coldWhileAppending, {
            ok: true, lists: 4, wholeLogReads: liveOwned ? cold : cold + 1, readsById: expectedColdReads,
            appends: Math.floor(cold / APPEND_EVERY),
          }, `generated, ${size} sessions, cold search while session 0 appends`)
          assert.deepEqual(generated.next, { ok: true, lists: 2, wholeLogReads: 0, readsById: {}, appends: 0 })
          // (The one append ran before this search; `appends` counts appends during a search.)
          assert.deepEqual(generated.appendedBetween, liveOwned
            ? { ok: true, lists: 2, wholeLogReads: 0, readsById: {}, appends: 0 }
            : { ok: true, lists: 2, wholeLogReads: 1, readsById: { [generated.firstId]: 1 }, appends: 0 }, 'only the changed session is re-read')
          assert.deepEqual(generated.quiet, { ok: true, lists: 2, wholeLogReads: 0, readsById: {}, appends: 0 })

          // Shipped: both attempts re-read every changed log, so the appends land in both.
          for (const [name, run] of Object.entries(shipped)) {
            assert.deepEqual(strip(run.coldWhileAppending), {
              ok: false, code: 'SESSION_QUERY_PERSISTENCE_FAILED', lists: 4, wholeLogReads: 2 * cold,
              appends: Math.floor((2 * cold) / APPEND_EVERY),
            }, `${name}, ${size} sessions, cold search while session 0 appends`)
            assert.deepEqual(strip(run.next), { ok: true, lists: 2, wholeLogReads: cold, appends: 0 }, `${name}: the failed pass committed nothing, the next search reads every log again`)
            assert.deepEqual(strip(run.appendedBetween), { ok: true, lists: 2, wholeLogReads: liveOwned ? 0 : 1, appends: 0 })
            assert.deepEqual(strip(run.quiet), { ok: true, lists: 2, wholeLogReads: 0, appends: 0 })
          }
        }
        t.diagnostic(JSON.stringify({ C3: { variant, appendEvery: APPEND_EVERY, table } }))
      })
    }

    test('C3 boundary: a stored session that appends after every single log read defeats both engines', { timeout: 60_000 }, async (t) => {
      const rows = {}
      for (const name of ['generated', ...SHIPPED]) {
        const run = await appendingSequence(name, 8, { liveOwned: false, appendEvery: 1 })
        rows[name] = { coldWhileAppending: run.coldWhileAppending, next: run.next }
      }
      t.diagnostic(JSON.stringify({ C3boundary: rows }))
      // The retry re-reads session 0 and that read appends again: two unstable attempts.
      assert.deepEqual({ ...rows.generated.coldWhileAppending, readsById: undefined }, { ok: false, code: 'SESSION_QUERY_PERSISTENCE_FAILED', lists: 4, wholeLogReads: 9, readsById: undefined, appends: 9 })
      assert.deepEqual(rows.generated.next, { ok: true, lists: 2, wholeLogReads: 1, readsById: { 'app-8-00': 1 }, appends: 0 }, 'the committed sessions survive the failure')
      for (const name of SHIPPED) {
        assert.deepEqual({ ...rows[name].coldWhileAppending, readsById: undefined }, { ok: false, code: 'SESSION_QUERY_PERSISTENCE_FAILED', lists: 4, wholeLogReads: 16, readsById: undefined, appends: 16 })
        assert.equal(rows[name].next.wholeLogReads, 8)
      }
    })

    // --- C4: unknown non-ignorable event type -------------------------------------------

    test('C4 unknown non-ignorable event type: both engines fail with the same code and message, the process stays alive', { timeout: 120_000 }, async (t) => {
      const base = fresh('c4')
      const root = path.join(base, 'sessions')
      const cwd = path.join(base, 'project')
      fs.mkdirSync(cwd)
      const UNKNOWN = 'ssp-test/unknown-required'
      const known = up.session.KNOWN_SESSION_EVENT_TYPES
      assert.equal(known.has(UNKNOWN), false)
      const store = await mountStore(up, root)
      for (let index = 0; index < 6; index += 1) {
        const handle = await store.P.create(makeHeader(up, `unk-${index}`, { createdAt: 100 + index, cwd }))
        await handle.append([userEvent(up, 0, 1, `needle ${index}`)])
        if (index === 3) {
          // Written by a "newer harness": admitted only while this append runs.
          known.add(UNKNOWN)
          try {
            await handle.append([{ type: UNKNOWN, seq: up.session.SessionSeq(1), time: 2, data: { note: 'required' } }])
          } finally {
            known.delete(UNKNOWN)
          }
        }
        await handle.close()
      }
      await store.dispose()
      assert.equal(known.has(UNKNOWN), false)

      // Separate processes: each engine fails, answers again, and the process exits normally.
      const children = {}
      for (const name of ['generated', 'shipped']) {
        const run = await runNode([PROBE_SCRIPT, 'unknown-type', '--upstream', UPSTREAM, '--engine', name, '--store', root, '--good-session', 'unk-0'], { timeoutMs: 60_000 })
        children[name] = { exit: run.code, signal: run.signal, result: probeResult(run) }
      }

      // In this process.
      const inProcess = {}
      const unhandled = []
      const onUnhandled = (reason) => unhandled.push(String(reason))
      process.on('unhandledRejection', onUnhandled)
      const mounted = {}
      try {
        for (const name of ['generated', ...SHIPPED]) {
          mounted[name] = await mountEngine(up, up.engines[name].Engine, root)
          const counter = instrumentPersistence(mounted[name].P)
          const cost = () => ({ reads: counter.snapshot().wholeLogReads, ...counter.opens() })
          const first = await outcome(mounted[name].search.searchSessions({ query: 'needle' }))
          const firstCost = cost()
          counter.reset()
          const second = await outcome(mounted[name].search.searchSessions({ query: 'needle' }))
          const secondCost = cost()
          counter.reset()
          const events = await outcome(mounted[name].search.searchEvents({ sessionId: up.session.SessionId('unk-0'), query: 'needle' }))
          inProcess[name] = { first, second, events, firstCost, secondCost, eventsCost: cost(), counter }
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
        // Recovery: move the log away; the same engine instances answer again, with equal hits.
        const project = fs.readdirSync(root).find((name) => fs.existsSync(path.join(root, name, 'unk-3')))
        fs.renameSync(path.join(root, project, 'unk-3'), path.join(base, 'unk-3-moved'))
        for (const name of Object.keys(mounted)) {
          inProcess[name].counter.reset()
          inProcess[name].recovered = await outcome(mounted[name].search.searchSessions({ query: 'needle' }))
          inProcess[name].recoveryCost = { reads: inProcess[name].counter.snapshot().wholeLogReads, ...inProcess[name].counter.opens() }
        }
      } finally {
        process.off('unhandledRejection', onUnhandled)
        for (const entry of Object.values(mounted)) await entry.dispose()
      }

      const shape = ({ ok, code, message, causeName }) => ({ ok, code, message, causeName })
      t.diagnostic(JSON.stringify({ C4: {
        children: Object.fromEntries(Object.entries(children).map(([name, c]) => [name, { exit: c.exit, signal: c.signal, alive: c.result?.alive, unhandled: c.result?.unhandled, firstCode: c.result?.first.code, secondCode: c.result?.second.code, eventsCode: c.result?.events.code }])),
        inProcess: Object.fromEntries(Object.entries(inProcess).map(([name, r]) => [name, { first: shape(r.first), secondCode: r.second.code, eventsCode: r.events.code, firstCost: r.firstCost, secondCost: r.secondCost, eventsCost: r.eventsCost, recovered: r.recovered.ok, recoveredHits: r.recovered.value?.items.length, recoveryCost: r.recoveryCost }])),
        unhandled,
      } }))

      const reference = shape(inProcess.shipped.first)
      assert.equal(reference.ok, false)
      assert.equal(reference.code, 'SESSION_QUERY_PERSISTENCE_FAILED')
      assert.equal(reference.causeName, 'SessionFormatUnsupportedError')
      assert.match(reference.message, /session "unk-3" contains event type "ssp-test\/unknown-required" \(seq 1\) unknown to this harness and not marked ignorable/)
      for (const [name, run] of Object.entries(inProcess)) {
        assert.deepEqual(shape(run.first), reference, `${name}: same code, message and cause as the shipped engine`)
        assert.deepEqual(shape(run.second), reference, `${name}: the next search fails the same way`)
        assert.deepEqual(shape(run.events), reference, `${name}: within-session search fails the same way`)
        assert.equal(run.recovered.ok, true, `${name}: the engine answers again once the log is gone`)
        assert.deepEqual(run.recovered.value, inProcess.shipped.recovered.value, `${name}: same hits after recovery`)
      }
      for (const [name, child] of Object.entries(children)) {
        assert.equal(child.exit, 0, `${name}: the process exited normally`)
        assert.equal(child.signal, null)
        assert.equal(child.result?.alive, true)
        assert.deepEqual(child.result?.unhandled, [], `${name}: no unhandled rejection or uncaught exception`)
        for (const key of ['first', 'second', 'events']) {
          assert.equal(child.result[key].code, 'SESSION_QUERY_PERSISTENCE_FAILED')
          assert.equal(child.result[key].message, reference.message, `${name} child: same message`)
        }
      }
      assert.deepEqual(unhandled, [])
      // The generated engine keeps what it committed before the failing log and retries only that log;
      // the shipped engine commits nothing and reads the same logs again.
      const before = inProcess.shipped.firstCost.reads // logs listed before unk-3
      for (const name of ['generated', ...SHIPPED]) {
        assert.deepEqual(inProcess[name].firstCost, { reads: before, opens: before + 1, openFailures: 1 }, `${name}: reads up to the refused log`)
      }
      for (const name of SHIPPED) assert.deepEqual(inProcess[name].secondCost, inProcess[name].firstCost, `${name}: the failed pass committed nothing`)
      assert.deepEqual(inProcess.generated.secondCost, { reads: 0, opens: 1, openFailures: 1 }, 'generated: only the refused log is tried again')
      assert.deepEqual(inProcess.generated.recoveryCost, { reads: 5 - before, opens: 5 - before, openFailures: 0 }, 'generated: recovery reads only the logs it had not committed')
      for (const name of SHIPPED) assert.deepEqual(inProcess[name].recoveryCost, { reads: 5, opens: 5, openFailures: 0 })
    })

    // --- C5: identical ordered hits -------------------------------------------------------

    test('C5 identical ordered hits and pages from both engines on a 60-session store (29 queries)', { timeout: 120_000 }, async (t) => {
      const base = fresh('c5')
      const root = path.join(base, 'sessions')
      const { cwds, written } = await writeComparisonStore(up, root, path.join(base, 'cwd'))
      const queries = comparisonQueries(up, cwds)
      const results = {}
      for (const name of ['generated', ...SHIPPED]) {
        const mounted = await mountEngine(up, up.engines[name].Engine, root)
        try {
          results[name] = []
          for (const query of queries) results[name].push(await runPaged(mounted.search, query))
        } finally {
          await mounted.dispose()
        }
      }
      const summary = queries.map((query, index) => ({
        label: query.label,
        kind: query.kind,
        pages: results.generated[index].length,
        items: results.generated[index].reduce((sum, page) => sum + page.items.length, 0),
      }))
      t.diagnostic(JSON.stringify({ C5: { sessions: written.length, events: written.reduce((sum, w) => sum + w.events, 0), queries: queries.length, summary } }))

      assert.ok(written.length >= 50)
      assert.ok(queries.length >= 20)
      for (const name of SHIPPED) {
        for (const [index, query] of queries.entries()) {
          assert.deepEqual(results.generated[index], results[name][index], `${name} vs generated: ${query.label}`)
        }
      }
      const byLabel = Object.fromEntries(summary.map((row) => [row.label, row]))
      assert.ok(summary.filter((row) => row.pages > 1).length >= 12, 'many queries page through cursors')
      for (const label of ['CJK Chinese', 'CJK Chinese two-character', 'CJK Japanese', 'Korean', 'phrase (words also loose)', 'event filter surface log-only (turn/end text)', 'events in cmp-018, CJK']) {
        assert.ok(byLabel[label].items > 0, `${label} has hits`)
      }
      for (const label of ['no hit', 'no hit CJK', 'events no hit', 'filter availability live (none)']) {
        assert.deepEqual([byLabel[label].pages, byLabel[label].items], [1, 0], `${label} is empty`)
      }
    })

    // --- C6: heap probe smoke --------------------------------------------------------------

    test('C6 the heap probe runs both engines under two heap caps (small synthetic store)', { timeout: 300_000 }, async (t) => {
      const out = path.join(fresh('c6'), 'store')
      const generated = await runNode([PROBE_SCRIPT, 'generate', '--upstream', UPSTREAM, '--out', out, '--plan', 'small'])
      const store = probeResult(generated)
      assert.equal(generated.code, 0, generated.stderr)
      const matrix = await runNode([PROBE_SCRIPT, 'matrix', '--upstream', UPSTREAM, '--store', store.root, '--caps', '256,512', '--engines', 'generated,shipped'])
      assert.equal(matrix.code, 0, matrix.stderr)
      const { rows } = probeResult(matrix)
      t.diagnostic(JSON.stringify({ C6: { store: { sessions: store.sessions, decodedTotal: store.decodedTotal, decodedMax: store.decodedMax }, rows: rows.map((r) => ({ cap: r.cap, engine: r.engine, exit: r.exitCode, peakHeapMB: r.peakHeapMB, traceGcPeakMB: r.traceGcPeakMB, maxRssMB: r.maxRssMB, firstSearchMs: r.firstSearchMs, hits: r.first?.hits })) } }))
      assert.equal(store.sessions, 60)
      assert.equal(rows.length, 4)
      for (const row of rows) {
        assert.equal(row.exitCode, 0)
        assert.equal(row.first.ok, true)
        assert.ok(row.peakHeapMB > 0 && row.traceGcPeakMB > 0)
        assert.deepEqual(row.firstCost, { lists: 2, wholeLogReads: 60 })
        assert.deepEqual(row.secondCost, { lists: 2, wholeLogReads: 0 })
      }
      for (const cap of [256, 512]) {
        const [gen, shipped] = ['generated', 'shipped'].map((engine) => rows.find((r) => r.cap === cap && r.engine === engine))
        assert.deepEqual(gen.first.hitIds, shipped.first.hitIds, `same hashed hit ids under cap ${cap}`)
      }
    })

    // --- C7b: decoys -------------------------------------------------------------------------

    test('C7 decoy HOME, DSH_HOME and XDG roots stayed empty', () => {
      for (const [key, dir] of Object.entries(decoys.folders)) assert.equal(process.env[key], dir)
      assert.deepEqual(decoys.touched(), [], 'no decoy folder received a file')
    })
  })
}
