import { Runtime } from 'foldkit'

import { release, signup, weather } from '../programs'
import { makeLab } from './lab'

const lab = makeLab([signup, release, weather])

Runtime.run(
  Runtime.makeApplication({
    ...lab,
    container: document.getElementById('root'),
    devTools: false,
  }),
)
