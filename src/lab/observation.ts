import { Array, Record } from 'effect'

import { canonical } from './canonical'
import { dataPath, dataShape } from './execution-data'
import type { ActionDescription, Interaction, Screen } from './interactions'

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

export const freezeCommands = (
  pending: ReadonlyArray<DescribedCommand>,
  path: string,
): void => {
  dataShape(pending, path, 'identify')
  Array.forEach(pending, (command, index) => {
    dataShape(command, dataPath(path, String(index)), 'identify')
    Object.freeze(command)
  })
  Object.freeze(pending)
}

export const commandKey = (command: DescribedCommand): string =>
  canonical([command.name, command.args ?? {}])

// NOTE: Foldkit identifies Command definitions by name, so those names must be
// unique within a program. Repeated invocations remain separate occurrences.
export const describeCommand = (
  command: DescribedCommand,
): CommandDescription => ({
  name: command.name,
  args: command.args ?? {},
})

export const describeCommands = (
  pending: ReadonlyArray<DescribedCommand>,
): ReadonlyArray<CommandDescription> => Array.map(pending, describeCommand)

export const interactionsRecord = <Message>(
  interactions: ReadonlyArray<Interaction<Message>>,
): Readonly<Record<string, Message>> =>
  Record.fromIterableWith(interactions, ({ key, message }) => [key, message])

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
