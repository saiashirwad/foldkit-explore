import { expect, test } from 'vitest'

import { formatValue } from './display'

test('ordinary JSON keeps its compact and indented display', () => {
  const value = { name: 'Ada', ready: true, items: [1, null] }
  expect(formatValue(value)).toBe(JSON.stringify(value))
  expect(formatValue(value, 2)).toBe(JSON.stringify(value, null, 2))
})

test('display text supports bigint and undefined without losing nested fields', () => {
  expect(formatValue(1n)).toBe('"1n"')
  expect(formatValue(undefined)).toBe('undefined')
  expect(formatValue({ value: 1n, missing: undefined })).toBe(
    '{"value":"1n","missing":"undefined"}',
  )
})
