import { AsyncData } from 'foldkit'

import { type Setup, respond } from './lab/atlas'
import { type Choices, fixture } from './lab/fixture'
import { FetchWeather, Message, type Model, WeatherAsyncData } from './main'
import { weatherData } from './main.fixture'

function* moves(model: Model): Choices<Message> {
  const typing = {
    typed: Message.UpdatedZipCodeInput({ value: '90210' }),
    cleared: Message.UpdatedZipCodeInput({ value: '' }),
  }
  if (AsyncData.isPending(model.weather)) {
    return yield* fixture('move', typing)
  }
  return yield* fixture('move', {
    ...typing,
    submitted: Message.SubmittedWeatherForm(),
  })
}

const responders = [
  respond(FetchWeather, function* ({ zipCode }) {
    if (zipCode === '') {
      return Message.FailedFetchWeather({ error: 'Zip code required' })
    }
    return yield* fixture('result', {
      succeeded: Message.SucceededFetchWeather({ weather: weatherData }),
      failed: Message.FailedFetchWeather({ error: 'Location not found' }),
    })
  }),
]

export function* WeatherCases(): Choices<Setup<Model, Message>> {
  const zipCodeInput = yield* fixture('zip', { empty: '', valid: '90210' })
  return {
    model: { zipCodeInput, weather: WeatherAsyncData.Idle() },
    moves,
    responders,
  }
}
