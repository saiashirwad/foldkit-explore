import { Schema } from 'effect'
import type { HtmlBuilder } from 'foldkit/html'
import { expect, test } from 'vitest'

import { make, send } from './atlas'
import { checkDecision } from './check-policy'
import { decodeEvidenceData, encodeEvidenceData } from './evidence-data'
import { fixture } from './fixture'

const program = {
  name: 'Policy',
  Model: Schema.Number,
  Message: Schema.Number,
  start: () => ({ model: 0 }),
  update: (_model: number, message: number) => ({ model: message }),
  view: (_model: number, h: HtmlBuilder<number>) => h.p([]),
}
const closed = { *starts() {} }
const safe = { id: 'safe', name: 'Safe', state: () => true }

test('CI policy never accepts incomplete, unexercised, counterexample or error reports', () => {
  const cases = [
    {
      atlas: make(program, closed, { properties: [safe] }),
      depth: 1,
      expected: { status: 'passed', exitCode: 0 },
    },
    {
      atlas: make(program, closed, {
        properties: [{ ...safe, state: () => false }],
      }),
      depth: 1,
      expected: { status: 'counterexample', exitCode: 1 },
    },
    {
      atlas: make(
        program,
        {
          *starts() {},
          *next() {
            return send(yield* fixture('event', { one: 1 }))
          },
        },
        { properties: [safe] },
      ),
      depth: 0,
      expected: { status: 'incomplete', exitCode: 2 },
    },
    {
      atlas: make(program, closed, {
        properties: [
          {
            ...safe,
            state: () => {
              throw new Error('predicate failed')
            },
          },
        ],
      }),
      depth: 1,
      expected: { status: 'error', exitCode: 3 },
    },
    {
      atlas: make(
        program,
        {
          *starts() {
            return yield* fixture('none', {})
          },
        },
        { properties: [safe] },
      ),
      depth: 1,
      expected: { status: 'not-exercised', exitCode: 4 },
    },
    {
      atlas: make(program, closed),
      depth: 1,
      expected: { status: 'not-exercised', exitCode: 4 },
    },
    {
      atlas: make(
        {
          ...program,
          start: () => {
            throw new Error('start failed')
          },
        },
        closed,
        { properties: [safe] },
      ),
      depth: 1,
      expected: { status: 'error', exitCode: 3 },
    },
  ]
  cases.forEach(({ atlas, depth, expected }) => {
    const report = atlas.check(depth)
    expect(checkDecision(report)).toEqual(expected)
    expect(
      decodeEvidenceData(
        JSON.parse(JSON.stringify(encodeEvidenceData(report))),
      ),
    ).toEqual(report)
    atlas.dispose()
  })
})
