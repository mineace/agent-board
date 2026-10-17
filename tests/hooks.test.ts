import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

type World = { files: Record<string, string>; spawned: { prompt: string; model?: string }[]; argv?: readonly string[]; percent: number }

const BOARD = '/proj/.claude/board.json'
const VIEW = '/proj/.claude/board-view.json'

// The engine beneath the plugin: files in memory, agents that start, the browser server's output.
const world = (on: On, serverLines: string[] = []): World => {
  const w: World = { files: {}, spawned: [], percent: 10 }
  mock.clock(on, { now: 1_000 })
  on('session.start', () => ({ cwd: '/proj' }) as never)
  on('agent.register', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('fs.read', (_$, e) => {
    const text = w.files[(e as { path: string }).path]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text } as never
  })
  on('fs.write', (_$, e) => {
    const { path, text } = e as unknown as { path: string; text: string }
    w.files[path] = text
    return { value: undefined } as never
  })
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 1, window: 1, percent: 1 }, rateLimits: [{ kind: 'five_hour', percentUsed: w.percent, resetsAt: '2030-01-01T00:00:00Z' }], cost: { usd: 0 } },
  }) as never)
  on('agent.spawn', (_$, e) => {
    w.spawned.push(e as never)
    return { agentId: `agent-${w.spawned.length}`, model: 'x' } as never
  })
  on('process.spawn', async function* (_$: unknown, e: unknown) {
    w.argv = (e as { argv: readonly string[] }).argv
    yield { stream: 'stderr', text: 'listening on http://localhost:4848\n' }
    for (const line of serverLines) yield { stream: 'stdout', text: line }
    return { value: { code: 0, signal: null } }
  } as never)
  return w
}

const board = (w: World) => JSON.parse(w.files[BOARD] ?? '{"cards":[]}') as { cards: { id: number; stage: string; status: string; models: Record<string, string> }[] }
// Lets the server loop and the agents' starts run (they are not awaited by the hooks).
const { setTimeout: later } = globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => void }
const settle = () => new Promise<void>(r => later(r, 50))

test('the browser server starts and what the page sends reaches the board', async ($, on) => {
  // A line may arrive in pieces.
  const w = world(on, ['{"op":"add","text":"Fix the', ' login test"}\n{"op":"model","id":1,"role":"execute","model":"haiku"}\n', '{"op":"act","id":1,"action":"approve"}\n'])
  await $.session.start({ cwd: '/proj' } as never)
  await settle()
  expect(w.argv?.[0]).toBe('node')
  expect(String(w.argv?.[1])).toContain('web/server.mjs')
  expect(w.argv?.slice(2)).toEqual(['4848', '127.0.0.1', BOARD, VIEW])
  const card = board(w).cards[0]
  expect(card?.models.execute).toBe('haiku')
  // Approve was not on offer while planning: a stale page cannot skip the plan.
  expect(card?.stage).toBe('plan')
  expect(w.spawned).toHaveLength(1)
  expect(w.spawned[0]?.prompt).toContain('Fix the login test')
  // The page learns which buttons the card offers.
  expect(JSON.parse(w.files[VIEW] ?? '{}').actions['1']).toContain('delete')
})

// Only core sets a started agent's id, so here every spawn counts as not started.
test('a card whose agent does not start waits for you, with Retry offered', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/proj' } as never)
  await $.tool.call({ tool: 'mcp__agent-board__add_card', text: 'Speed up CI' } as never)
  await settle()
  expect(w.spawned).toHaveLength(1)
  expect(board(w).cards[0]?.status).toContain('Needs you')
  expect(JSON.parse(w.files[VIEW] ?? '{}').actions['1']).toContain('retry')
})

test('no agent starts while plan usage is past the pause level', async ($, on) => {
  const w = world(on)
  w.percent = 95
  await $.session.start({ cwd: '/proj' } as never)
  await $.tool.call({ tool: 'mcp__agent-board__add_card', text: 'Big refactor' } as never)
  await settle()
  expect(w.spawned).toHaveLength(0)
  expect(JSON.parse(w.files[VIEW] ?? '{}').isPaused).toBe(true)
})

test('webPort 0 starts no server', { options: { webPort: 0 } }, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/proj' } as never)
  await settle()
  expect(w.argv).toBe(undefined)
})
