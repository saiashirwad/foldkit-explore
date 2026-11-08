import { Runtime } from 'foldkit'

import * as Weather from '../main'
import { weatherEnvironment } from '../main.cases'
import * as Release from '../release/main'
import { releaseEnvironment } from '../release/main.cases'
import * as Signup from '../signup/main'
import { signupEnvironment } from '../signup/main.cases'
import { makeCase, makeLab } from './lab'

const lab = makeLab([
  makeCase(
    {
      name: 'Signup',
      start: Signup.init,
      update: Signup.update,
      view: Signup.view,
    },
    signupEnvironment,
  ),
  makeCase(
    {
      name: 'Release',
      start: Release.init,
      update: Release.update,
      view: Release.view,
    },
    releaseEnvironment,
  ),
  makeCase(
    {
      name: 'Weather',
      start: Weather.start,
      update: Weather.update,
      view: (model, h) => Weather.view(model, h).body,
    },
    weatherEnvironment,
  ),
])

Runtime.run(
  Runtime.makeApplication({
    ...lab,
    container: document.getElementById('root'),
    devTools: false,
  }),
)
