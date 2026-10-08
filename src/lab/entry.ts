import { Runtime } from 'foldkit'

import { release, weather } from '../programs'
import { makeLab } from './lab'

const lab = makeLab([release, weather])

Runtime.run(
  Runtime.makeApplication({
    ...lab,
    container: document.getElementById('root'),
    devTools: false,
  }),
)
