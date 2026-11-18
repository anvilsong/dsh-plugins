import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
const dir = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-session-query-sqlite'
const guard = await import(process.argv[2])
const manifest = JSON.parse(readFileSync(dir + '/package.json', 'utf8'))
console.log(`manifest version ${manifest.version} (guard PINNED_VERSION ${guard.PINNED_VERSION}: ${manifest.version === guard.PINNED_VERSION ? 'equal' : 'DIFFERENT'})`)
for (const [file, pin] of Object.entries(guard.PINNED_SOURCES)) {
  const bytes = readFileSync(`${dir}/${file}`)
  const digest = createHash('sha256').update(bytes).digest('hex')
  console.log(`${file} ${bytes.length} bytes ${digest} ${digest === pin ? 'equals the guard.js pin' : 'DIFFERS from the guard.js pin ' + pin}`)
}
