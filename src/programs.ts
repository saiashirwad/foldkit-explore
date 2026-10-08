import * as Atlas from './lab/atlas'
import * as Weather from './main'
import { WeatherCases } from './main.cases'
import * as Release from './release/main'
import { ReleaseCases } from './release/main.cases'

export const weather = Atlas.make({
  name: 'Weather',
  Model: Weather.Model,
  Message: Weather.Message,
  update: Weather.update,
  view: (model, h) => Weather.view(model, h).body,
  cases: WeatherCases,
})

export const release = Atlas.make({
  name: 'Release',
  Model: Release.Model,
  Message: Release.Message,
  update: Release.update,
  view: Release.view,
  cases: ReleaseCases,
})
