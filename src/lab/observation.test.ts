import { expect, test } from 'vitest'

import { commandKey, describeCommands } from './observation'

test('describes Command names and structured arguments without losing occurrences', () => {
  const command = { name: 'CheckUsername', args: { username: 'ada' } }
  expect(describeCommands([command, command, { name: 'Refresh' }])).toEqual([
    { name: 'CheckUsername', args: { username: 'ada' } },
    { name: 'CheckUsername', args: { username: 'ada' } },
    { name: 'Refresh', args: {} },
  ])
})

test('matches Commands by unique name and canonical arguments', () => {
  expect(commandKey({ name: 'Check', args: { a: 1, b: 2 } })).toBe(
    commandKey({ name: 'Check', args: { b: 2, a: 1 } }),
  )
  expect(commandKey({ name: 'Refresh' })).toBe(
    commandKey({ name: 'Refresh', args: {} }),
  )
  expect(commandKey({ name: 'Check', args: { a: 1 } })).not.toBe(
    commandKey({ name: 'Check', args: { a: 2 } }),
  )
  expect(commandKey({ name: 'Check', args: {} })).not.toBe(
    commandKey({ name: 'Refresh', args: {} }),
  )
})
