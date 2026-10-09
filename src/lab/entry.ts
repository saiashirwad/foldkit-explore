import { Runtime } from 'foldkit'

import { release, signup, signupLongContent, weather } from '../programs'
import { makeLab } from './lab'

const lab = makeLab([signup, signupLongContent, release, weather])

Runtime.run(
  Runtime.makeApplication({
    ...lab,
    container: document.getElementById('root'),
    devTools: false,
  }),
)
