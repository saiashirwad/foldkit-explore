import { Array, Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'
import * as Scene from 'foldkit/scene'

export type InputDomain = Readonly<{
  label: string
  values: ReadonlyArray<string>
}>

export type Interaction<Message> = Readonly<{
  label: string
  message: Message
}>

type Tree = Scene.SceneSimulation<unknown, unknown>['html']

const markup = (node: Tree): unknown => ({
  tag: node.sel,
  text: node.text,
  attributes: node.data?.attrs,
  properties: node.data?.props,
  classes: node.data?.class,
  dataset: node.data?.dataset,
  style: node.data?.style,
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
): Readonly<{
  screen: string
  interactions: ReadonlyArray<Interaction<Message>>
}> => {
  const interactions: Array<Interaction<Message>> = []
  const screens: Array<string> = []
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
    if (messages.length > 1) {
      throw new Error(
        `Unsupported interaction ${JSON.stringify(label)}: emitted ${messages.length} Messages; only single-message interactions are supported.`,
      )
    }
    Array.forEach(messages, message => interactions.push({ label, message }))
  }
  Scene.scene(
    capture([]),
    Scene.given(model),
    Scene.tap(simulation => {
      screens.push(JSON.stringify(markup(simulation.html)))
      Array.forEach(
        Scene.getAllByRole('button', { disabled: false })(simulation.html),
        (button, index) => {
          probe(
            `click ${Scene.textContent(button)}`,
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
            !Scene.getAllByRole('textbox', { disabled: false })(
              simulation.html,
            ).includes(node) ||
            Option.contains(Scene.attr(node, 'readOnly'), 'true') ||
            Option.contains(Scene.attr(node, 'aria-readonly'), 'true')
          ) {
            return
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
  return { screen: screens[0] ?? '', interactions }
}
