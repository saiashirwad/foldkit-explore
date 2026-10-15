type ReplayLimits = Readonly<{
  hops?: number
  work?: number
}>

export type ReplayOptions = Readonly<{
  limits?: ReplayLimits
  signal?: AbortSignal
}>

const defaultReplayLimits = Object.freeze({
  hops: 1_000,
  work: 1_000_000,
})

type ReplayDivergence =
  | 'address'
  | 'hop-kind'
  | 'fixture'
  | 'option'
  | 'incomplete-decisions'
  | 'excessive-decisions'
  | 'message'
  | 'request'
  | 'identity'
  | 'artifact'
  | 'evidence'
  | 'missing-event'

export class ReplayDivergenceError extends Error {
  readonly _tag = 'ReplayDivergenceError'
  constructor(
    readonly reason: ReplayDivergence,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

export class ReplayLimitError extends Error {
  readonly _tag = 'ReplayLimitError'
  constructor(
    readonly limit: 'hops' | 'work',
    readonly allowance: number,
  ) {
    super(`Replay exceeded its ${limit} allowance of ${allowance}.`)
  }
}

export class ReplayCancelledError extends Error {
  readonly _tag = 'ReplayCancelledError'
  constructor() {
    super('Replay was cancelled.')
  }
}

const allowance = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `Replay ${name} allowance must be a nonnegative safe integer.`,
    )
  }
  return value
}

// NOTE: Every iterator advancement, including the completion probe, consumes work.
// Closing this wrapper also closes any suspended authored choice generator.
export function* boundedReplaySteps<Output>(
  iterator: Iterator<void, Output>,
  hops: number,
  options: ReplayOptions = {},
): Generator<void, Output> {
  let work = 0
  try {
    const limits = {
      hops: allowance(options.limits?.hops ?? defaultReplayLimits.hops, 'hop'),
      work: allowance(options.limits?.work ?? defaultReplayLimits.work, 'work'),
    }
    if (hops > limits.hops) {
      throw new ReplayLimitError('hops', limits.hops)
    }
    while (true) {
      if (options.signal?.aborted) {
        throw new ReplayCancelledError()
      }
      if (work >= limits.work) {
        throw new ReplayLimitError('work', limits.work)
      }
      work += 1
      const step = iterator.next()
      if (step.done) {
        return step.value
      }
      yield
    }
  } finally {
    iterator.return?.()
  }
}

export const finishReplay = <Output>(
  iterator: Iterator<void, Output>,
): Output => {
  try {
    const cursor = { step: iterator.next() }
    while (!cursor.step.done) {
      cursor.step = iterator.next()
    }
    return cursor.step.value
  } finally {
    iterator.return?.()
  }
}
