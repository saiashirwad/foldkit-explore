import { Cause, Effect, Exit, Option, Scope, Semaphore } from 'effect'

import { AnalysisStatus } from './analysis-data'
import { InvalidModelError } from './execution-error'
import { makeIdentity } from './identity'
import { ReplayCancelledError } from './replay'

export const CHUNK_SIZE = 128

type Session = Readonly<{ dispose: () => void }>
type RunRequest = Readonly<{
  runId: number
  key: string
  reset: boolean
}>
type RunResult<Value> = Readonly<{
  status: AnalysisStatus
  maybeValue: Option.Option<Value>
}>

// NOTE: One identity remembers frozen references across snapshots, so data
// already frozen by an earlier snapshot is not rescanned. Clearing its buckets
// keeps it from holding those snapshots.
const snapshots = makeIdentity()

export const immutable = <Value>(value: Value): Value => {
  try {
    snapshots.of(value, 'analysis snapshot')
  } finally {
    snapshots.clear()
  }
  return value
}

export const failureStatus = (error: unknown): AnalysisStatus =>
  error instanceof ReplayCancelledError
    ? AnalysisStatus.Cancelled()
    : error instanceof InvalidModelError
      ? AnalysisStatus.InvalidModel({ reason: error.message })
      : AnalysisStatus.Defect({
          reason: error instanceof Error ? error.message : String(error),
        })

// NOTE: One chunk returns one Message. The next chunk is declared by update,
// and a scheduled sleep lets browser input run before acquiring session ownership.
export const makeRunner = <Resource extends Session>() => {
  const gate = Semaphore.makeUnsafe(1)
  const owned: {
    watermark: number
    closed: boolean
    current:
      | Readonly<{
          key: string
          runId: number
          scope: Scope.Closeable
          resource: Resource
        }>
      | undefined
  } = { watermark: 0, closed: false, current: undefined }

  const release = Effect.suspend(() => {
    const current = owned.current
    owned.current = undefined
    return current === undefined
      ? Effect.void
      : Scope.close(current.scope, Exit.void)
  })

  const cancel = (runId: number) =>
    Semaphore.withPermit(gate)(
      Effect.gen(function* () {
        if (runId < owned.watermark) {
          return
        }
        owned.watermark = runId
        yield* release
      }),
    )

  const run = <Value>(
    request: RunRequest,
    create: () => Resource,
    advance: (
      resource: Resource,
      newRun: boolean,
    ) => Readonly<{ done: boolean; value: Value }>,
    chunks: number,
  ): Effect.Effect<RunResult<Value>> =>
    Effect.gen(function* () {
      yield* Effect.sleep(1)
      return yield* Semaphore.withPermit(gate)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (owned.closed || request.runId < owned.watermark) {
              return {
                status: AnalysisStatus.Cancelled(),
                maybeValue: Option.none<Value>(),
              }
            }
            const previous = owned.current
            const newRun =
              previous === undefined || previous.runId !== request.runId
            owned.watermark = request.runId
            if (
              previous === undefined ||
              previous.key !== request.key ||
              (request.reset && newRun)
            ) {
              yield* release
              const scope = yield* Scope.make()
              const resource = yield* Effect.sync(create)
              yield* Scope.addFinalizer(
                scope,
                Effect.sync(() => resource.dispose()),
              )
              owned.current = {
                key: request.key,
                runId: request.runId,
                scope,
                resource,
              }
            } else {
              owned.current = { ...previous, runId: request.runId }
            }
            const current = owned.current
            if (current === undefined) {
              throw new Error('Analysis session was not acquired.')
            }
            const result = yield* Effect.sync(() =>
              advance(current.resource, newRun),
            )
            return {
              status: result.done
                ? AnalysisStatus.Completed()
                : AnalysisStatus.Running({ chunks: chunks + 1 }),
              maybeValue: Option.some(immutable(result.value)),
            }
          }),
        ),
      )
    }).pipe(
      Effect.catchCause(cause =>
        Effect.gen(function* () {
          yield* Effect.exit(cancel(request.runId))
          return {
            status: failureStatus(Cause.squash(cause)),
            maybeValue: Option.none<Value>(),
          }
        }),
      ),
    )

  const shutdown = Semaphore.withPermit(gate)(
    Effect.gen(function* () {
      owned.closed = true
      yield* release
    }),
  )

  return { run, cancel, shutdown }
}
