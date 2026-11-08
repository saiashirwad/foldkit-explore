import { Array } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'
import * as Scene from 'foldkit/scene'

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
