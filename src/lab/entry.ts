import { Runtime } from 'foldkit'

import { comparisons } from '../comparisons'
import { release, signup, signupLongContent, weather } from '../programs'
import { makeLab } from './lab'

const lab = makeLab([signup, signupLongContent, release, weather], comparisons)

Runtime.run(
  Runtime.makeApplication({
    ...lab,
    container: document.getElementById('root'),
    devTools: false,
  }),
)
