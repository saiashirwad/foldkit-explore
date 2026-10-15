import { Array, Effect } from 'effect'
import type { Update } from 'foldkit'
import * as Scene from 'foldkit/scene'

import type { Message, Model, makeLab } from './lab'

type Application = ReturnType<typeof makeLab>

export const settle = async (
  application: Readonly<{
    update: (model: Model, message: Message) => Update.Return<Model, Message>
  }>,
  result: Update.Return<Model, Message>,
): Promise<Model> => {
  const pending = [...(result.commands ?? [])]
  const current = { model: result.model, chunks: 0 }
  while (Array.isArrayNonEmpty(pending)) {
    const command = pending.shift()
    if (command === undefined) {
      continue
    }
    current.chunks += 1
    if (current.chunks > 10_000) {
      throw new Error('Analysis did not complete within test allowance.')
    }
    const message = await Effect.runPromise(command.effect)
    const updated = application.update(current.model, message)
    current.model = updated.model
    pending.push(...(updated.commands ?? []))
  }
  return current.model
}

export const dispatch = (
  application: Application,
  model: Model,
  message: Message,
) => settle(application, application.update(model, message))

// NOTE: Integration scenes run real declared analysis Commands between steps.
// Foldkit Scene itself remains synchronous and never executes Effects.
export const analysisScene = async (
  application: Application,
  model: Model,
  ...steps: ReadonlyArray<Scene.SceneStep<Model, Message, undefined>>
): Promise<Model> => {
  const current = { model }
  for (const step of steps) {
    const produced: Array<Update.Return<Model, Message>> = []
    Scene.scene(
      {
        view: application.view,
        update: (model, message) => {
          const updated = application.update(model, message)
          produced.push(updated)
          return { model: updated.model }
        },
      },
      Scene.given(current.model),
      step,
    )
    for (const result of produced) {
      current.model = await settle(application, result)
    }
  }
  return current.model
}
