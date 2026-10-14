// @vitest-environment node

import { Schema } from 'effect'
import { spawnSync } from 'node:child_process'
import { expect, test } from 'vitest'

import { CheckReport } from './atlas'
import { EvidenceData, decodeEvidenceData } from './evidence-data'

const Output = Schema.Struct({
  version: Schema.Literal(1),
  decision: Schema.Struct({ status: Schema.String, exitCode: Schema.Number }),
  reportEncoding: Schema.Literal('foldkit-execution-data-v1'),
  report: EvidenceData,
})

test.each([
  ['safe', 0, 'passed'],
  ['counterexample', 1, 'counterexample'],
  ['incomplete', 2, 'incomplete'],
  ['error', 3, 'error'],
  ['empty', 4, 'not-exercised'],
])(
  'headless CLI %s preserves JSON report and CI exit policy in a fresh process',
  (scenario, code, status) => {
    const result = spawnSync(
      'bun',
      ['scripts/check.mjs', `--scenario=${scenario}`],
      { encoding: 'utf8', timeout: 30_000 },
    )
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(code)
    const output = Schema.decodeUnknownSync(Output)(JSON.parse(result.stdout))
    expect(output.decision).toEqual({ status, exitCode: code })
    const report = Schema.decodeUnknownSync(CheckReport)(
      decodeEvidenceData(output.report),
    )
    expect(report.version).toBe(1)
    expect(report.coverage.search).toBe('breadth')
  },
)

test('headless CLI invalid input is an execution error, never a successful check', () => {
  const result = spawnSync('bun', ['scripts/check.mjs', '--scenario=unknown'], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  expect(result.status).toBe(3)
  expect(JSON.parse(result.stdout)).toMatchObject({
    decision: { status: 'error', exitCode: 3 },
  })
})
