import { Array } from 'effect'

import { canonical } from './canonical'
import type { ActionDescription, Screen } from './interactions'

export type CommandDescription = Readonly<{
  name: string
  args: unknown
}>

export type Observation = Readonly<{
  screen: Screen
  actions: ReadonlyArray<ActionDescription>
  pending: ReadonlyArray<CommandDescription>
}>

type DescribedCommand = Readonly<{ name: string; args?: unknown }>

export const commandKey = (command: DescribedCommand): string =>
  canonical([command.name, command.args ?? {}])

// NOTE: Foldkit identifies Command definitions by name, so those names must be
// unique within a program. Repeated invocations remain separate occurrences.
export const describeCommands = (
  pending: ReadonlyArray<DescribedCommand>,
): ReadonlyArray<CommandDescription> =>
  Array.map(pending, command => ({
    name: command.name,
    args: command.args ?? {},
  }))

export const observationOf = (
  inspected: Readonly<{
    screen: Screen
    interactions: ReadonlyArray<ActionDescription>
  }>,
  pending: ReadonlyArray<DescribedCommand>,
): Observation => ({
  screen: inspected.screen,
  actions: Array.map(inspected.interactions, ({ key, label }) => ({
    key,
    label,
  })),
  pending: describeCommands(pending),
})
