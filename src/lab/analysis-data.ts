import { Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import {
  CheckReport,
  ReachSnapshot,
  ReachStatus,
  Search,
  StateSnapshot,
  SuccessorStatus,
} from './atlas'
import { Decision } from './fixture'
import type { Screen } from './interactions'

export const AnalysisStatus = defineTaggedUnion({
  Idle: {},
  Running: { chunks: Schema.Number },
  Completed: {},
  Cancelled: {},
  InvalidModel: { reason: Schema.String },
  Defect: { reason: Schema.String },
})
export type AnalysisStatus = typeof AnalysisStatus.Type

export const GallerySnapshot = Schema.Struct({
  depth: Schema.Number,
  search: Search,
  reached: ReachSnapshot,
  states: Schema.Array(StateSnapshot),
  groups: Schema.Array(
    Schema.Struct({ home: Schema.String, states: Schema.Array(Schema.String) }),
  ),
  fixtures: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      options: Schema.Array(Schema.String),
    }),
  ),
  maybeCheck: Schema.Option(CheckReport),
})
export type GallerySnapshot = typeof GallerySnapshot.Type

const CommandSnapshot = Schema.Struct({
  name: Schema.String,
  args: Schema.Unknown,
})
const unknownRecord = Schema.Record(Schema.String, Schema.Unknown)
const ScreenSnapshot: Schema.Codec<Screen> = Schema.Struct({
  tag: Schema.String,
  text: Schema.String,
  attributes: unknownRecord,
  properties: unknownRecord,
  classes: Schema.Record(Schema.String, Schema.Boolean),
  dataset: unknownRecord,
  style: unknownRecord,
  children: Schema.Array(
    Schema.Union([Schema.String, Schema.suspend(() => ScreenSnapshot)]),
  ),
})
const ExecutionSnapshot = Schema.Struct({
  id: Schema.String,
  input: Schema.Unknown,
  model: Schema.Unknown,
  pending: Schema.Array(CommandSnapshot),
  observation: Schema.Struct({
    screen: ScreenSnapshot,
    actions: Schema.Array(
      Schema.Struct({ key: Schema.String, label: Schema.String }),
    ),
    pending: Schema.Array(CommandSnapshot),
  }),
})
const EventSnapshot = Schema.Struct({
  kind: Schema.Literals(['Move', 'Answer']),
  key: Schema.String,
  label: Schema.String,
  message: Schema.Unknown,
  decisions: Schema.Array(Decision),
  request: Schema.optionalKey(
    Schema.Struct({
      command: CommandSnapshot,
      occurrence: Schema.Number,
      index: Schema.Number,
    }),
  ),
})
const ComparisonStepSnapshot = Schema.Struct({
  kind: Schema.Literals(['Start', 'Transition']),
  label: Schema.String,
  startDecisions: Schema.Array(Decision),
  before: Schema.optional(ExecutionSnapshot),
  after: Schema.optional(ExecutionSnapshot),
  beforeEvent: Schema.optional(EventSnapshot),
  afterEvent: Schema.optional(EventSnapshot),
  beforeIssued: Schema.Array(CommandSnapshot),
  afterIssued: Schema.Array(CommandSnapshot),
})
export const ExampleSnapshot = Schema.Struct({
  id: Schema.String,
  pair: Schema.String,
  depth: Schema.Number,
  trace: Schema.Array(ComparisonStepSnapshot),
  before: Schema.optional(ExecutionSnapshot),
  after: Schema.optional(ExecutionSnapshot),
})
export const ComparisonSnapshot = Schema.Struct({
  name: Schema.String,
  status: Schema.Literals([...ReachStatus.literals, 'pair-limit', 'running']),
  limits: Schema.Struct({
    depth: Schema.Number,
    states: Schema.Number,
    pairs: Schema.Number,
    transitions: Schema.Number,
    enumerationWork: Schema.Number,
  }),
  counters: Schema.Struct({
    starts: Schema.Number,
    beforeStates: Schema.Number,
    afterStates: Schema.Number,
    pairs: Schema.Number,
    transitions: Schema.Number,
    beforeTransitions: Schema.Number,
    afterTransitions: Schema.Number,
    enumerationWork: Schema.Number,
    joinOperations: Schema.Number,
  }),
  findings: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      kind: Schema.Literals([
        'content',
        'action-added',
        'action-removed',
        'action-changed',
        'pending',
        'commands',
        'event-added',
        'event-removed',
        'property',
      ]),
      title: Schema.String,
      description: Schema.String,
      before: Schema.Unknown,
      after: Schema.Unknown,
      examples: Schema.Array(ExampleSnapshot),
      shortest: ExampleSnapshot,
    }),
  ),
  propertyFailures: Schema.Array(
    Schema.Struct({
      propertyId: Schema.String,
      property: Schema.String,
      side: Schema.Literals(['before', 'after']),
      kind: Schema.Literals(['state', 'transition']),
      example: ExampleSnapshot,
    }),
  ),
  unfinishedWork: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(['starts', 'pair']),
      pair: Schema.String,
      depth: Schema.Number,
      before: SuccessorStatus,
      after: SuccessorStatus,
      beforeAlternatives: Schema.Number,
      afterAlternatives: Schema.Number,
    }),
  ),
})
export type ComparisonSnapshot = typeof ComparisonSnapshot.Type
