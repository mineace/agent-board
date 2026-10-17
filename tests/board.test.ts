import { expect, test } from 'claude-code/testing'

import { EMPTY, act, actionsFor, addCard, finished, orphaned, parseWebAction, started, toStart } from '../hooks/board'

test('a card runs plan, approve, execute, review to done', async () => {
  let [b, card] = addCard(EMPTY, 'Fix the login test\nIt flakes on CI', 0, true)
  expect(card.title).toBe('Fix the login test')
  expect(card.stage).toBe('plan')
  expect(toStart(b, 1).map(c => c.id)).toEqual([1])
  b = started(b, 1, 'a1', 1)
  expect(toStart(b, 1)).toHaveLength(0)
  b = finished(b, 1, 'the plan', 100, 2)
  expect(b.cards[0]?.stage).toBe('approve')
  expect(toStart(b, 1)).toHaveLength(0)
  expect(actionsFor(b.cards[0]!)).toContain('approve')
  b = act(b, 1, 'approve', 3)
  expect(b.cards[0]?.stage).toBe('execute')
  b = finished(started(b, 1, 'a2', 4), 1, 'did it', 100, 5)
  expect(b.cards[0]?.stage).toBe('review')
  b = finished(started(b, 1, 'a3', 6), 1, 'VERDICT: PASS', 100, 7)
  expect(b.cards[0]?.stage).toBe('done')
  expect(b.cards[0]?.tokens).toBe(300)
})

test('a failing review goes back to execute, then waits for you', async () => {
  let [b] = addCard(EMPTY, 'x', 0, true)
  b = { ...b, cards: b.cards.map(c => ({ ...c, stage: 'review' as const })) }
  for (let i = 0; i < 2; i++) {
    b = finished(b, 1, 'VERDICT: FAIL', 0, i)
    expect(b.cards[0]?.stage).toBe('execute')
    b = { ...b, cards: b.cards.map(c => ({ ...c, stage: 'review' as const })) }
  }
  b = finished(b, 1, 'VERDICT: FAIL', 0, 9)
  expect(b.cards[0]?.status).toContain('Needs you')
  expect(actionsFor(b.cards[0]!)).toContain('retry')
})

test('without autoStart a card waits in backlog; agents of a past session are restarted', async () => {
  let [b] = addCard(EMPTY, 'x', 0, false)
  expect(toStart(b, 1)).toHaveLength(0)
  b = started(act(b, 1, 'start', 1), 1, 'gone', 2)
  b = orphaned(b, 3)
  expect(b.cards[0]?.agentId).toBe(undefined)
  expect(toStart(b, 1)).toHaveLength(1)
})

test('only well-formed browser actions get through', async () => {
  expect(parseWebAction('{"op":"add","text":"hi"}')).toEqual({ op: 'add', text: 'hi' })
  expect(parseWebAction('{"op":"act","id":3,"action":"approve"}')).toEqual({ op: 'act', id: 3, action: 'approve' })
  expect(parseWebAction('{"op":"setting","field":"maxParallel","value":2}')).toEqual({ op: 'setting', field: 'maxParallel', value: 2 })
  expect(parseWebAction('{"op":"act","id":3,"action":"rm -rf"}')).toBe(undefined)
  expect(parseWebAction('{"op":"setting","field":"webPort","value":1}')).toBe(undefined)
  expect(parseWebAction('{"op":"setting","field":"maxParallel","value":99}')).toBe(undefined)
  expect(parseWebAction('{"op":"model","id":1,"role":"plan","model":"gpt"}')).toBe(undefined)
  expect(parseWebAction('{"op":"add","text":"   "}')).toBe(undefined)
  expect(parseWebAction('not json')).toBe(undefined)
})
