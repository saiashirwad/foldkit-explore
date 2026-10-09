import { AsyncData } from 'foldkit'

import {
  type NextState,
  type Setup,
  type Transition,
  answer,
  pendingRequests,
  send,
} from './lab/atlas'
import { type Choices, fixture } from './lab/fixture'
import { FetchWeather, Message, type Model, WeatherAsyncData } from './main'
import { weatherData } from './main.fixture'

function* next(state: NextState<Model, Message>): Choices<Transition<Message>> {
  const kind = yield* fixture('next', { user: 'user', response: 'response' })
  if (kind === 'user') {
    const typing = {
      typed: Message.UpdatedZipCodeInput({ value: '90210' }),
      cleared: Message.UpdatedZipCodeInput({ value: '' }),
    }
    const actions = AsyncData.isPending(state.model.weather)
      ? typing
      : { ...typing, submitted: Message.SubmittedWeatherForm() }
    return send(yield* fixture('move', actions))
  }
  const request = yield* fixture(
    'pending',
    pendingRequests(state, FetchWeather),
  )
  if (request.command.args.zipCode === '') {
    return answer(
      request,
      Message.FailedFetchWeather({ error: 'Zip code required' }),
    )
  }
  const message = yield* fixture('result', {
    succeeded: Message.SucceededFetchWeather({ weather: weatherData }),
    failed: Message.FailedFetchWeather({ error: 'Location not found' }),
  })
  return answer(request, message)
}

export function* WeatherCases(): Choices<Setup<Model, Message>> {
  const zipCodeInput = yield* fixture('zip', { empty: '', valid: '90210' })
  return {
    model: { zipCodeInput, weather: WeatherAsyncData.Idle() },
    next,
  }
}
