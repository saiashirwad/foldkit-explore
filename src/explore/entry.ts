import { Runtime } from 'foldkit'

import * as Weather from '../main'
import { weatherEnvironment } from '../main.cases'
import * as Release from '../release/main'
import { releaseEnvironment } from '../release/main.cases'
import { signupEnvironment } from '../signup/main.cases'
import {
  headingChanged,
  helperRefactor,
  original,
  retryRemoved,
  staleResponses,
} from '../signup/variants'
import { makeCase, makeComparison, makeLab } from './lab'

const lab = makeLab(
  [
    makeCase(original, signupEnvironment),
    makeCase(
      {
        name: 'Release',
        Message: Release.Message,
        start: Release.init,
        update: Release.update,
        view: Release.view,
      },
      releaseEnvironment,
    ),
    makeCase(
      {
        name: 'Weather',
        Message: Weather.Message,
        start: Weather.start,
        update: Weather.update,
        view: (model, h) => Weather.view(model, h).body,
      },
      weatherEnvironment,
    ),
  ],
  [headingChanged, retryRemoved, staleResponses, helperRefactor].map(after =>
    makeComparison(after.name, original, after, signupEnvironment),
  ),
)

Runtime.run(
  Runtime.makeApplication({
    ...lab,
    container: document.getElementById('root'),
    devTools: false,
  }),
)
