import * as Atlas from './lab/atlas'
import * as Weather from './main'
import { weatherEnvironment } from './main.cases'
import * as Release from './release/main'
import { releaseEnvironment } from './release/main.cases'
import * as Signup from './signup/main'
import {
  signupEnvironment,
  signupLongContentEnvironment,
} from './signup/main.cases'
import { properties } from './signup/properties'

export {
  weatherEnvironment,
  releaseEnvironment,
  signupEnvironment,
  signupLongContentEnvironment,
}

export const weatherProgram: Atlas.Program<
  Weather.Model,
  Weather.Message,
  string
> = {
  name: 'Weather',
  Model: Weather.Model,
  Message: Weather.Message,
  start: Weather.start,
  update: Weather.update,
  view: (model, h) => Weather.view(model, h).body,
}

export const releaseProgram: Atlas.Program<Release.Model, Release.Message> = {
  name: 'Release',
  Model: Release.Model,
  Message: Release.Message,
  start: Release.init,
  update: Release.update,
  view: Release.view,
}

export const signupProgram: Atlas.Program<
  Signup.Model,
  Signup.Message,
  Signup.Plan
> = {
  name: 'Signup',
  Model: Signup.Model,
  Message: Signup.Message,
  start: Signup.init,
  update: Signup.update,
  view: Signup.view,
}

export const weather = Atlas.make(weatherProgram, weatherEnvironment)
export const release = Atlas.make(releaseProgram, releaseEnvironment)
export const signup = Atlas.make(signupProgram, signupEnvironment, {
  properties,
})
export const signupLongContent = Atlas.make(
  { ...signupProgram, name: 'Signup · long content' },
  signupLongContentEnvironment,
  { properties },
)
