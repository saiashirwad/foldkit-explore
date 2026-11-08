import { expect, test } from 'vitest'

import { type Choices, fixture, outcomes } from './choices'

test('yields every combination, depth first, with the options picked', () => {
  function* pair(): Choices<string> {
    const size = yield* fixture('size', { small: 's', large: 'L' })
    const color = yield* fixture('color', { red: 'r', blue: 'b' })
    return size + color
  }
  expect([...outcomes(pair)]).toEqual([
    { path: ['small', 'red'], value: 'sr' },
    { path: ['small', 'blue'], value: 'sb' },
    { path: ['large', 'red'], value: 'Lr' },
    { path: ['large', 'blue'], value: 'Lb' },
  ])
})

test('control flow decides which fixtures are reached', () => {
  function* either(): Choices<string> {
    const kind = yield* fixture('kind', { text: 'text', none: 'none' })
    return kind === 'text'
      ? yield* fixture('value', { a: 'a', b: 'b' })
      : 'nothing'
  }
  expect([...outcomes(either)].map(outcome => outcome.value)).toEqual([
    'a',
    'b',
    'nothing',
  ])
})

test('an empty fixture prunes its path', () => {
  function* pruned(): Choices<number> {
    const n = yield* fixture('n', { one: 1, two: 2, three: 3 })
    yield* fixture('even only', n % 2 === 0 ? { ok: 0 } : {})
    return n
  }
  expect([...outcomes(pruned)].map(outcome => outcome.value)).toEqual([2])
})

test('solves n queens', () => {
  const size = 5
  function* queens(): Choices<ReadonlyArray<number>> {
    const columns: Array<number> = []
    for (let row = 0; row < size; row++) {
      const free = Object.fromEntries(
        [...Array(size).keys()]
          .filter(column =>
            columns.every(
              (placed, other) =>
                placed !== column && Math.abs(placed - column) !== row - other,
            ),
          )
          .map(column => [`${column}`, column]),
      )
      columns.push(yield* fixture(`row ${row}`, free))
    }
    return columns
  }
  expect([...outcomes(queens)]).toHaveLength(10)
})
