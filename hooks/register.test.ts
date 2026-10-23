import { expect, test } from 'claude-code/testing'

import { cellsFor, cut, fitRow, folderOf, prettyModel, windowsFor } from './register'

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

test('long names are cut with an ellipsis', () => {
  expect(cut('main', 20)).toBe('main')
  expect(cut('feature/very-long-branch-name', 10)).toBe('feature/v…')
})

test('the row gives up pieces in order, the usage meter last', () => {
  const left = { name: 'Opus 5.5', level: 'medium', folder: 'mini-hud', branch: 'main*', percent: '~13%', filled: 1, value: 13 }
  const meter = [{ kind: 'five_hour', label: '5h', percent: 42, filled: 4, used: ' 42%', reset: ' ↻ 1h 3m' }]
  // Left: model 8, effort 9, 'mini-hud git:(main*)' 23, folder gone 14, ctx with bar 22, % only 11.
  // Meter: with bar 25, without 14, without reset 6. Two columns between the two sides.
  const off = (room: number) => Object.entries(fitRow(left, meter, room)).filter(([key, on]) => !on && key !== 'hasBothWindows').map(([key]) => key) // one window: nothing to give up there
  expect(off(62 + 2 + 25)).toEqual([])
  expect(off(62 + 2 + 25 - 1)).toEqual(['hasContextBar'])
  expect(off(51 + 2 + 14)).toEqual(['hasContextBar', 'hasMeterBar'])
  expect(off(42 + 2 + 14)).toEqual(['hasContextBar', 'hasMeterBar', 'hasFolder'])
  expect(off(42 + 2 + 6)).toEqual(['hasContextBar', 'hasMeterBar', 'hasFolder', 'hasReset'])
  expect(off(28 + 2 + 6)).toContain('hasBranch')
  expect(off(19 + 2 + 6)).toContain('hasEffort')
  expect(off(8 + 2 + 6)).toContain('hasContext')
  expect(off(8)).toContain('hasModel')
  expect(off(8)).not.toContain('hasMeter')
  expect(off(7)).toContain('hasMeter')
})

test('the hint and what is beneath the meter take room too', () => {
  const left = { name: 'Opus 5.5', level: '', folder: '', branch: '', percent: '', filled: 0, value: 0 }
  const meter = [{ kind: 'five_hour', label: '5h', percent: 42, filled: 4, used: ' 42%', reset: '' }]
  // 'Opus 5.5 · ? for help' 21, gap 2, '5h 42%' 6, ' · focus' 8
  expect(fitRow(left, meter, 37, 10, 5).hasModel).toBe(true)
  expect(fitRow(left, meter, 36, 10, 5).hasModel).toBe(false)
})

test('with both windows shown, the one nearest its limit stays alone', () => {
  const meter = [
    { kind: 'five_hour', label: '5h', percent: 42, filled: 4, used: ' 42%', reset: '' },
    { kind: 'seven_day', label: 'week', percent: 71, filled: 7, used: ' 71%', reset: '' }
  ]
  const left = { name: '', level: '', folder: '', branch: '', percent: '', filled: 0, value: 0 }
  expect(windowsFor(meter, fitRow(left, meter, Infinity)).length).toBe(2)
  const one = fitRow(left, meter, 2 + 'week 71%'.length)
  expect(windowsFor(meter, one).map(w => w.kind)).toEqual(['seven_day'])
})
