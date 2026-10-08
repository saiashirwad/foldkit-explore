import * as Atlas from './lab/atlas'
import * as Weather from './main'
import { WeatherCases } from './main.cases'
import * as Release from './release/main'
import { ReleaseCases } from './release/main.cases'
import * as Signup from './signup/main'
import { SignupCases } from './signup/main.cases'
import { properties } from './signup/properties'

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

export const signup = Atlas.make({
  name: 'Signup',
  schedule: 'any',
  properties,
  Model: Signup.Model,
  Message: Signup.Message,
  update: Signup.update,
  view: Signup.view,
  cases: SignupCases,
})
