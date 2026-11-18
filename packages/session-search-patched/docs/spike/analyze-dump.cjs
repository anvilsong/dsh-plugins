// S1 spike: summarize where sessionQuery engine rows sit in a `dsh --dump-config` output.
// Run with the DSH runtime (it carries js-yaml), through scratch-home.mjs:
//   node scripts/scratch-home.mjs run <root> -- "<DSH Electron>" docs/spike/analyze-dump.cjs <baseline dump> <dump>...
// with ELECTRON_RUN_AS_NODE=1 set through --set.
'use strict'
const fs = require('node:fs')
const { createRequire } = require('node:module')

const INSTALL = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-app-boot/package.json'
const yaml = createRequire(INSTALL)('js-yaml')
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: data => ({ __jsExpr: data }) })
const schema = yaml.DEFAULT_SCHEMA.extend([JsExpr])
const ENGINES = new Set(['@deepseek-ai/dsh-session-query-sqlite', 'dsh-plugin-session-search-patched'])
const TOOL = 'optional-tool-session-query'
const GROUP = 'optional-session-search'

function load(file) {
  return yaml.load(fs.readFileSync(file, 'utf8'), { schema }) ?? []
}

function state(disabled) {
  if (disabled && typeof disabled === 'object' && '__jsExpr' in disabled) return `dynamic(!!js ${disabled.__jsExpr})`
  return disabled === true ? 'disabled' : 'enabled'
}

function walk(rows, scope, out, ancestorsDisabled = false) {
  for (const row of rows) {
    const isGroup = row.group === true && Array.isArray(row.config)
    if (ENGINES.has(row.name)) {
      const own = state(row.disabled)
      out.engines.push({ id: row.id, name: row.name, scope, state: ancestorsDisabled ? 'disabled(ancestor)' : own, config: row.config })
    }
    if (row.id === TOOL) out.tool = row
    if (row.id === GROUP) out.group = { isolate: row.isolate, children: (row.config ?? []).map(child => child.id) }
    if (isGroup) {
      const isolated = row.isolate && row.isolate.sessionQuery !== undefined
      walk(row.config, isolated ? `group:${row.id}` : scope, out, ancestorsDisabled || row.disabled === true)
    }
  }
  return out
}

const [baselineFile, ...files] = process.argv.slice(2)
const baseline = walk(load(baselineFile), 'root', { engines: [] })
for (const file of files) {
  const result = walk(load(file), 'root', { engines: [] })
  const inGroup = result.engines.filter(engine => engine.scope === `group:${GROUP}`)
  const enabledInGroup = inGroup.filter(engine => engine.state !== 'disabled' && engine.state !== 'disabled(ancestor)')
  const rootEngines = result.engines.filter(engine => engine.scope === 'root')
  const lines = [`# ${file}`]
  for (const engine of result.engines) lines.push(`engine ${engine.id} (${engine.name}) scope=${engine.scope} state=${engine.state}`)
  lines.push(`group ${GROUP}: ${result.group ? `present isolate=${JSON.stringify(result.group.isolate)} children=${JSON.stringify(result.group.children)}` : 'ABSENT'}`)
  lines.push(`check exactly one enabled engine row in group: ${enabledInGroup.length === 1 ? 'yes' : `NO (${enabledInGroup.length}: ${enabledInGroup.map(engine => `${engine.id}=${engine.state}`).join(', ')})`}`)
  lines.push(`check the enabled group engine is session-query-sqlite-patched: ${enabledInGroup.length === 1 && enabledInGroup[0].id === 'session-query-sqlite-patched' ? 'yes' : 'no'}`)
  lines.push(`check root engine rows are only session-query-sqlite with openAt never: ${rootEngines.every(engine => engine.id === 'session-query-sqlite' && engine.config?.openAt === 'never') && rootEngines.length === 1 ? 'yes' : `NO ${JSON.stringify(rootEngines.map(engine => engine.id))}`}`)
  lines.push(`check tool row unchanged against baseline: ${JSON.stringify(result.tool) === JSON.stringify(baseline.tool) ? 'yes' : `NO ${JSON.stringify(result.tool)}`}`)
  lines.push(`check group isolate {sessionQuery: true}: ${result.group && JSON.stringify(result.group.isolate) === '{"sessionQuery":true}' ? 'yes' : 'NO'}`)
  process.stdout.write(lines.join('\n') + '\n\n')
}
