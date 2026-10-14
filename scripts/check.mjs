import { Window } from 'happy-dom'
import { parseArgs } from 'node:util'

const window = new Window()
Object.defineProperty(globalThis, 'document', {
  value: window.document,
  configurable: true,
})
try {
  const { runHeadlessCheck } = await import('../src/lab/headless-check.ts')
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      scenario: { type: 'string', default: 'safe' },
      depth: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  })
  if (values.depth !== undefined && !/^\d+$/.test(values.depth)) {
    throw new Error('Depth must be a nonnegative integer')
  }
  const result = runHeadlessCheck(
    values.scenario,
    values.depth === undefined ? undefined : Number(values.depth),
  )
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.exitCode = result.decision.exitCode
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ version: 1, decision: { status: 'error', exitCode: 3 }, reason: error instanceof Error ? error.message : String(error) })}\n`,
  )
  process.exitCode = 3
} finally {
  await window.happyDOM.close()
}
