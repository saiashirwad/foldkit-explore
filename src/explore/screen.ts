import { Array } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'
import * as Scene from 'foldkit/scene'

import type { State } from './explore'
import { keyOf } from './key'

export type Screen = Readonly<{
  // The visible text, for people.
  text: string
  // Everything rendered, for matching.
  key: string
}>

type Tree = Scene.SceneSimulation<unknown, unknown>['html']

const markup = (node: Tree): unknown => ({
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

const textOf = (node: Tree | string): string =>
  typeof node === 'string'
    ? node
    : [node.text ?? '', ...Array.map(node.children ?? [], textOf)]
        .filter(part => part !== '')
        .join(' ')

// NOTE: Scene renders the real view. The update here never runs.
export const screenOf = <Model, Message>(
  view: (model: Model, h: HtmlBuilder<Message>) => Html,
  model: Model,
): Screen => {
  const screens: Array<Screen> = []
  Scene.scene(
    { view, update: (current: Model) => ({ model: current }) },
    Scene.given(model),
    Scene.tap(simulation => {
      screens.push({
        text: textOf(simulation.html),
        key: keyOf(markup(simulation.html)),
      })
    }),
  )
  return screens[0] ?? { text: '', key: '' }
}

// A merge key for `Environment.key`: states that render the same screen with
// the same pending requests are one state, however they got there.
export const byScreen =
  <Model, Message, Input>(
    view: (model: Model, h: HtmlBuilder<Message>) => Html,
  ) =>
  (state: State<Model, Message, Input>): unknown => [
    screenOf(view, state.model).key,
    Array.map(state.pending, command => [command.name, command.args ?? {}]),
  ]
