import { Array, Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'
import * as Scene from 'foldkit/scene'

import { moveKey } from './canonical'

export type InputDomain = Readonly<{
  label: string
  values: ReadonlyArray<string>
}>

export type ActionDescription = Readonly<{
  key: string
  label: string
}>

export type Interaction<Message> = ActionDescription &
  Readonly<{ message: Message }>

export type Screen = Readonly<{
  tag: string
  text: string
  attributes: Readonly<Record<string, unknown>>
  properties: Readonly<Record<string, unknown>>
  classes: Readonly<Record<string, boolean>>
  dataset: Readonly<Record<string, unknown>>
  style: Readonly<Record<string, unknown>>
  children: ReadonlyArray<Screen | string>
}>

type Tree = Scene.SceneSimulation<unknown, unknown>['html']

const markup = (node: Tree): Screen => ({
  tag: node.sel ?? '',
  text: node.text ?? '',
  attributes: node.data?.attrs ?? {},
  properties: Object.fromEntries(Object.entries(node.data?.props ?? {})),
  classes: node.data?.class ?? {},
  dataset: node.data?.dataset ?? {},
  style: node.data?.style ?? {},
  children: Array.map(node.children ?? [], child =>
    typeof child === 'string' ? child : markup(child),
  ),
})

// NOTE: Scene is Foldkit's public interaction driver. This probe records the
// Messages emitted by real handlers; it never runs update or executes Commands.
export const inspect = <Model, Message>(
  view: (model: Model, h: HtmlBuilder<Message>) => Html,
  model: Model,
  inputs: ReadonlyArray<InputDomain>,
  encodeMessage: (message: Message) => unknown = message => message,
): Readonly<{
  screen: Screen
  interactions: ReadonlyArray<Interaction<Message>>
}> => {
  const interactions: Array<Interaction<Message>> = []
  const screens: Array<Screen> = []
  const capture = (messages: Array<Message>) => ({
    view,
    update: (current: Model, message: Message) => {
      messages.push(message)
      return { model: current }
    },
  })
  const probe = (
    label: string,
    step: Scene.SceneStep<Model, Message, undefined>,
  ) => {
    const messages: Array<Message> = []
    Scene.scene(capture(messages), Scene.given(model), step)
    if (messages.length !== 1) {
      throw new Error(
        `Unsupported interaction ${JSON.stringify(label)}: emitted ${messages.length} Messages; only single-message interactions are supported.`,
      )
    }
    Array.forEach(messages, message => {
      try {
        const key = moveKey(encodeMessage(message))
        interactions.push({ key, label, message })
      } catch (cause) {
        throw new Error(
          `Invalid Message from interaction ${JSON.stringify(label)}: it could not be encoded for matching.`,
          { cause },
        )
      }
    })
  }
  Scene.scene(
    capture([]),
    Scene.given(model),
    Scene.tap(simulation => {
      screens.push(markup(simulation.html))
      Array.forEach(
        Scene.getAllByRole('button', { disabled: false })(simulation.html),
        (button, index) => {
          probe(
            `click ${Option.getOrElse(Scene.attr(button, 'aria-label'), () => Scene.textContent(button))}`,
            Scene.click(
              Scene.nth(index)(Scene.all.role('button', { disabled: false })),
            ),
          )
        },
      )
      Array.forEach(inputs, input => {
        const matches = Scene.getAllByLabel(input.label)(simulation.html)
        Array.forEach(matches, (node, index) => {
          if (
            Option.contains(Scene.attr(node, 'disabled'), 'true') ||
            Option.contains(Scene.attr(node, 'aria-disabled'), 'true') ||
            Option.contains(Scene.attr(node, 'readOnly'), 'true') ||
            Option.contains(Scene.attr(node, 'aria-readonly'), 'true')
          ) {
            return
          }
          if (
            !Scene.getAllByRole('textbox', { disabled: false })(
              simulation.html,
            ).includes(node)
          ) {
            throw new Error(
              `Unsupported input ${JSON.stringify(input.label)}: configured values require an editable textbox.`,
            )
          }
          Array.forEach(input.values, value => {
            probe(
              `${input.label} = ${JSON.stringify(value)}`,
              Scene.type(Scene.nth(index)(Scene.all.label(input.label)), value),
            )
          })
        })
      })
    }),
  )
  return {
    screen: Option.getOrThrowWith(
      Array.head(screens),
      () => new Error('Scene inspection did not produce a screen.'),
    ),
    interactions,
  }
}
