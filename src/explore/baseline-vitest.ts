import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { expect } from 'vitest'

import {
  type Snapshot,
  decodeSnapshot,
  diffSnapshots,
  encodeSnapshot,
  formatFindings,
} from './baseline'

// Fails with the differences when `current` no longer matches the committed
// baseline. Run with UPDATE_BASELINE=1 to write the baseline instead, and
// review its diff like any other change. A missing baseline is written too.
export const expectBaseline = (file: string, current: Snapshot): void => {
  if (process.env['UPDATE_BASELINE'] === '1' || !existsSync(file)) {
    writeFileSync(file, encodeSnapshot(current))
    return
  }
  const baseline = decodeSnapshot(readFileSync(file, 'utf8'))
  expect(formatFindings(diffSnapshots(baseline, current)), file).toBe('')
}
