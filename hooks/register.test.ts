import { expect, test } from 'claude-code/testing'

import { moonFor, prettyModel } from './register'

test('model ids read as names', () => {
  expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(prettyModel('claude-sonnet-4-5-20250929[1m]')).toBe('Sonnet 4.5 1M')
  expect(prettyModel('claude-haiku-4')).toBe('Haiku 4')
  expect(prettyModel('opus')).toBe('Opus')
  expect(prettyModel('gpt-x.y')).toBe('gpt-x.y')
})

test('the moon fills with the context', () => {
  expect(moonFor(0)).toBe('🌑')
  expect(moonFor(30)).toBe('🌒')
  expect(moonFor(50)).toBe('🌓')
  expect(moonFor(70)).toBe('🌔')
  expect(moonFor(95)).toBe('🌕')
  expect(moonFor(140)).toBe('🌕')
})
