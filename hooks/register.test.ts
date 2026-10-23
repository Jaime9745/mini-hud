import { expect, test } from 'claude-code/testing'

import { cellsFor, folderOf, prettyModel } from './register'

test('model ids read as names', () => {
  expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(prettyModel('claude-sonnet-4-5-20250929[1m]')).toBe('Sonnet 4.5 1M')
  expect(prettyModel('claude-haiku-4')).toBe('Haiku 4')
  expect(prettyModel('opus')).toBe('Opus')
  expect(prettyModel('gpt-x.y')).toBe('gpt-x.y')
})

test('the context bar fills ten cells', () => {
  expect(cellsFor(0)).toBe(0)
  expect(cellsFor(48)).toBe(5)
  expect(cellsFor(100)).toBe(10)
  expect(cellsFor(140)).toBe(10)
  expect(cellsFor(-3)).toBe(0)
})

test('the folder is the last segment of the path', () => {
  expect(folderOf('C:\\Users\\jaime\\mini-hud')).toBe('mini-hud')
  expect(folderOf('/home/me/work/app/')).toBe('app')
})
