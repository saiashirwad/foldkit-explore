import { Array, Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import { canonical } from './canonical'
import { EvidenceData, encodeEvidenceData } from './evidence-data'
import { Decision } from './fixture'
import { makeIdentity } from './identity'
import { type Observation, describeCommands } from './observation'
import { ReplayDivergenceError } from './replay'

const EVIDENCE_FORMAT = 'foldkit-explore/evidence'
const EVIDENCE_VERSION = 1
const EVIDENCE_DATA_ENCODING = 'foldkit-data/v1'

export const ReplayIdentity = Schema.Struct({
  program: Schema.String,
  environment: Schema.String,
  inputEncoding: Schema.String,
  modelEncoding: Schema.String,
  messageEncoding: Schema.String,
})
export type ReplayIdentity = typeof ReplayIdentity.Type

export const EvidenceCommand = Schema.Struct({
  name: Schema.String,
  args: EvidenceData,
})
export type EvidenceCommand = typeof EvidenceCommand.Type

const EvidenceExecution = Schema.Struct({
  input: EvidenceData,
  model: EvidenceData,
  encodedModel: EvidenceData,
  pending: Schema.Array(EvidenceCommand),
  observation: EvidenceData,
})
type EvidenceExecution = typeof EvidenceExecution.Type

const transitionFields = {
  decisions: Schema.Array(Decision),
  message: EvidenceData,
  encodedMessage: EvidenceData,
  execution: EvidenceExecution,
  issued: Schema.Array(EvidenceCommand),
}
export const EvidenceStep = defineTaggedUnion({
  Start: {
    decisions: Schema.Array(Decision),
    execution: EvidenceExecution,
    issued: Schema.Array(EvidenceCommand),
  },
  Move: transitionFields,
  Answer: {
    ...transitionFields,
    request: Schema.Struct({
      index: Schema.Natural,
      occurrence: Schema.Natural,
      command: EvidenceCommand,
    }),
  },
  Event: transitionFields,
})
export type EvidenceStep = typeof EvidenceStep.Type

export const EvidenceArtifact = Schema.Struct({
  format: Schema.Literal(EVIDENCE_FORMAT),
  version: Schema.Literal(EVIDENCE_VERSION),
  dataEncoding: Schema.Literal(EVIDENCE_DATA_ENCODING),
  identity: ReplayIdentity,
  steps: Schema.Array(EvidenceStep),
})
export type EvidenceArtifact = typeof EvidenceArtifact.Type

export const assertReplayIdentity = (identity: ReplayIdentity): void => {
  makeIdentity().of(identity, 'replay identity')
  if (
    !Schema.is(ReplayIdentity)(identity) ||
    Object.getOwnPropertyNames(identity).length !== 5 ||
    [
      identity.program,
      identity.environment,
      identity.inputEncoding,
      identity.modelEncoding,
      identity.messageEncoding,
    ].some(value => value.trim() === '')
  ) {
    throw new ReplayDivergenceError(
      'identity',
      'Replay requires explicit program, environment and encoding identifiers.',
    )
  }
}

export const evidenceCommands = (
  commands: ReadonlyArray<Readonly<{ name: string; args?: unknown }>>,
): ReadonlyArray<EvidenceCommand> =>
  Array.map(describeCommands(commands), ({ name, args }) => ({
    name,
    args: encodeEvidenceData(args),
  }))

export const evidenceExecution = (
  input: unknown,
  model: unknown,
  encodedModel: unknown,
  pending: ReadonlyArray<Readonly<{ name: string; args?: unknown }>>,
  observation: Observation,
): EvidenceExecution => ({
  input: encodeEvidenceData(input),
  model: encodeEvidenceData(model),
  encodedModel: encodeEvidenceData(encodedModel),
  pending: evidenceCommands(pending),
  observation: encodeEvidenceData(observation),
})

export const evidenceArtifact = (
  identity: ReplayIdentity,
  steps: ReadonlyArray<EvidenceStep>,
): EvidenceArtifact => {
  assertReplayIdentity(identity)
  const artifact: EvidenceArtifact = {
    format: EVIDENCE_FORMAT,
    version: EVIDENCE_VERSION,
    dataEncoding: EVIDENCE_DATA_ENCODING,
    identity: {
      program: identity.program,
      environment: identity.environment,
      inputEncoding: identity.inputEncoding,
      modelEncoding: identity.modelEncoding,
      messageEncoding: identity.messageEncoding,
    },
    steps,
  }
  makeIdentity().of(artifact, 'evidence artifact')
  return artifact
}

export const serializeEvidence = (artifact: EvidenceArtifact): string => {
  makeIdentity().of(artifact, 'evidence artifact')
  if (!Schema.is(EvidenceArtifact)(artifact)) {
    throw new ReplayDivergenceError(
      'artifact',
      'Invalid Foldkit evidence artifact.',
    )
  }
  return JSON.stringify(Schema.encodeSync(EvidenceArtifact)(artifact))
}

export const parseEvidence = (serialized: string): EvidenceArtifact => {
  try {
    const artifact = Schema.decodeUnknownSync(EvidenceArtifact)(
      JSON.parse(serialized),
    )
    assertReplayIdentity(artifact.identity)
    makeIdentity().of(artifact, 'evidence artifact')
    return artifact
  } catch (cause) {
    throw new ReplayDivergenceError(
      'artifact',
      'Invalid or unsupported Foldkit evidence artifact.',
      { cause },
    )
  }
}

export const assertEvidenceIdentity = (
  artifact: EvidenceArtifact,
  identity: ReplayIdentity,
): void => {
  assertReplayIdentity(identity)
  makeIdentity().of(artifact, 'evidence artifact')
  if (!Schema.is(EvidenceArtifact)(artifact)) {
    throw new ReplayDivergenceError(
      'artifact',
      'Invalid or unsupported Foldkit evidence artifact.',
    )
  }
  if (canonical(artifact.identity) !== canonical(identity)) {
    throw new ReplayDivergenceError(
      'identity',
      'Evidence program, environment or encoding identity changed.',
    )
  }
}

export const assertSameEvidence = (
  actual: EvidenceArtifact,
  expected: EvidenceArtifact,
): void => {
  if (canonical(actual) !== canonical(expected)) {
    throw new ReplayDivergenceError(
      'evidence',
      'Replay diverged from its recorded execution evidence.',
    )
  }
}
