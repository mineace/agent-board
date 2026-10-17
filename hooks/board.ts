import type { Board, Card, Model, Role, Stage } from '../types'

export const STAGES: readonly Stage[] = ['backlog', 'plan', 'approve', 'execute', 'review', 'done']

export const STAGE_NAMES: Record<Stage, string> = {
  backlog: 'Backlog',
  plan: 'Plan',
  approve: 'Approve',
  execute: 'Execute',
  review: 'Review',
  done: 'Done',
}

export const ROLE_OF: Partial<Record<Stage, Role>> = { plan: 'plan', execute: 'execute', review: 'review' }

export const MODELS: readonly Model[] = ['inherit', 'opus', 'sonnet', 'haiku']

/** Executor runs a failed review may send a card back for before it waits for you. */
export const MAX_ATTEMPTS = 2

export const EMPTY: Board = { nextId: 1, cards: [] }

export type Settings = {
  maxParallel: number
  models: Record<Role, Model>
  autoStart: boolean
  pauseAtLimit: number
  /** Executor and reviewer work in a git worktree per card. */
  worktrees: boolean
  /** A desktop notification when a card needs you. */
  notify: boolean
  /** Board agents run their role's allowlisted commands without a prompt or auto mode's check. Off by default. */
  allowlist: boolean
}

/**
 * The checklist under the plan's "Acceptance criteria" heading: its bullet or numbered lines, up to
 * the next heading or the end. Empty when the plan has none.
 */
export const parseCriteria = (plan: string): string[] => {
  const lines = plan.split('\n')
  const at = lines.findIndex(l => /^\W*acceptance criteria\W*$/i.test(l.trim()))
  if (at < 0) return []
  const items: string[] = []
  for (const line of lines.slice(at + 1)) {
    const t = line.trim()
    if (/^#{1,6}\s/.test(t) || (/^\**[A-Z][^:]{0,60}:\**$/.test(t) && items.length)) break
    const item = t.match(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]?\]\s*)?(.+)$/)
    if (item?.[1]) items.push(item[1].trim())
  }
  return items.slice(0, 30)
}

/** A card waiting for you, or done with a branch to merge: what a notification is raised for. */
export const needsYou = (c: Card) => c.status.startsWith('Needs you')

export const readBoard = (text: string | undefined): Board => {
  if (!text) return EMPTY
  try {
    const parsed = JSON.parse(text) as Partial<Board>
    if (!Array.isArray(parsed.cards)) return EMPTY
    return { nextId: Number(parsed.nextId) || parsed.cards.length + 1, cards: parsed.cards }
  } catch {
    return EMPTY
  }
}

export const writeBoard = (board: Board) => `${JSON.stringify(board, null, 2)}\n`

const touch = (card: Card, now: number, patch: Partial<Card>, note?: string): Card => ({
  ...card,
  ...patch,
  updatedAt: now,
  log: note ? [...card.log, { at: now, text: note }].slice(-50) : card.log,
})

export const update = (board: Board, id: number, fn: (card: Card) => Card): Board => ({
  ...board,
  cards: board.cards.map(c => (c.id === id ? fn(c) : c)),
})

export const find = (board: Board, id: number | undefined) => board.cards.find(c => c.id === id)

/** A new card from what was typed: the first line is its title, all of it the request. */
export const addCard = (board: Board, text: string, now: number, autoStart: boolean, source?: string): [Board, Card] => {
  const request = text.trim()
  const title = (request.split('\n')[0] ?? '').slice(0, 80)
  // A suggestion from a board agent waits for you, whatever auto-start says.
  const isStarted = autoStart && !source
  const card: Card = {
    id: board.nextId,
    title,
    request,
    ...(source ? { source } : {}),
    stage: isStarted ? 'plan' : 'backlog',
    models: {},
    status: isStarted ? 'Queued for planning' : source ? `Suggested by ${source}` : 'In backlog',
    attempts: 0,
    tokens: 0,
    createdAt: now,
    updatedAt: now,
    log: [{ at: now, text: source ? `Suggested by ${source}` : 'Created' }],
  }
  return [{ nextId: board.nextId + 1, cards: [...board.cards, card] }, card]
}

/** Cards that need an agent and have none, oldest first. */
export const waiting = (board: Board) =>
  board.cards
    .filter(c => ROLE_OF[c.stage] && !c.agentId && !c.status.startsWith('Needs you'))
    .sort((a, b) => a.updatedAt - b.updatedAt)

export const running = (board: Board) => board.cards.filter(c => c.agentId)

/** The cards to start now, within the parallel limit. */
export const toStart = (board: Board, maxParallel: number) =>
  waiting(board).slice(0, Math.max(0, Math.max(1, maxParallel) - running(board).length))

export const modelFor = (card: Card, role: Role, settings: Settings): Model => card.models[role] ?? settings.models[role]

export const started = (board: Board, id: number, agentId: string, now: number) =>
  update(board, id, c => touch(c, now, { agentId, status: `${STAGE_NAMES[c.stage]}: agent working` }, `${STAGE_NAMES[c.stage]} started`))

/** Moves a card on with what its agent answered. */
export const finished = (board: Board, id: number, answer: string, tokens: number, now: number): Board =>
  update(board, id, c => {
    const spent = { agentId: undefined, tokens: c.tokens + tokens }
    if (c.stage === 'plan') {
      return touch(c, now, { ...spent, plan: answer, criteria: parseCriteria(answer), stage: 'approve', status: 'Needs you: approve the plan' }, 'Plan written')
    }
    if (c.stage === 'execute') {
      return touch(c, now, { ...spent, result: answer, stage: 'review', status: 'Queued for review' }, 'Work done')
    }
    if (c.stage === 'review') {
      const passed = /^\s*VERDICT:\s*PASS/im.test(answer)
      if (passed) {
        const status = c.worktree ? `Needs you: merge or discard ${c.worktree.branch}` : 'Done'
        return touch(c, now, { ...spent, review: answer, stage: 'done', status }, 'Review passed')
      }
      if (c.attempts < MAX_ATTEMPTS) {
        return touch(
          c,
          now,
          { ...spent, review: answer, stage: 'execute', attempts: c.attempts + 1, status: 'Queued: fixing review findings' },
          'Review found problems; back to Execute',
        )
      }
      return touch(c, now, { ...spent, review: answer, status: 'Needs you: review still failing' }, 'Review failed again')
    }
    return touch(c, now, spent)
  })

/** An agent that ended without answering (error, interruption). */
export const failed = (board: Board, id: number, why: string, now: number) =>
  update(board, id, c =>
    touch(c, now, { agentId: undefined, status: `Needs you: ${STAGE_NAMES[c.stage]} stopped (${why})` }, `${STAGE_NAMES[c.stage]} stopped: ${why}`),
  )

/**
 * Cards whose agent is gone (an earlier session, or one that ended unseen): queue them again.
 * `alive` holds the agents still working, so a reload mid-run leaves their cards alone.
 */
export const orphaned = (board: Board, now: number, alive: ReadonlySet<string> = new Set()): Board => ({
  ...board,
  cards: board.cards.map(c =>
    c.agentId && !alive.has(c.agentId) ? touch(c, now, { agentId: undefined, status: `Queued: ${STAGE_NAMES[c.stage]} restarted` }, 'Agent lost with the last session; restarting') : c,
  ),
})

export type Action = 'start' | 'approve' | 'replan' | 'retry' | 'done' | 'delete' | 'reopen' | 'merge' | 'discard'

/** What the person pressed on a card. */
export const act = (board: Board, id: number, action: Action, now: number): Board => {
  if (action === 'delete') return { ...board, cards: board.cards.filter(c => c.id !== id) }
  return update(board, id, c => {
    switch (action) {
      case 'start':
        return touch(c, now, { stage: 'plan', status: 'Queued for planning' }, 'Started')
      case 'approve':
        return touch(c, now, { stage: 'execute', status: 'Queued for execution' }, 'Plan approved')
      case 'replan':
        return touch(c, now, { stage: 'plan', plan: undefined, criteria: undefined, status: 'Queued for planning' }, 'Sent back to planning')
      case 'retry':
        return touch(c, now, { status: `Queued: ${STAGE_NAMES[c.stage]} retry`, attempts: 0 }, 'Retried')
      case 'done': {
        const status = c.worktree ? `Needs you: merge or discard ${c.worktree.branch}` : 'Done'
        return touch(c, now, { stage: 'done', agentId: undefined, status }, 'Marked done')
      }
      case 'merge':
      case 'discard':
        // The git work is the caller's; this records its outcome (see branchClosed).
        return c
      case 'reopen':
        return touch(c, now, { stage: 'backlog', status: 'In backlog' }, 'Reopened')
    }
  })
}

/** Which buttons a card offers, by where it stands. */
export const actionsFor = (c: Card): Action[] => {
  if (c.agentId) return ['done', 'delete']
  const stuck = c.status.startsWith('Needs you') && c.stage !== 'approve'
  switch (c.stage) {
    case 'backlog':
      return ['start', 'delete']
    case 'approve':
      return ['approve', 'replan', 'delete']
    case 'done':
      return c.worktree ? ['merge', 'discard', 'reopen', 'delete'] : ['reopen', 'delete']
    default:
      return stuck ? ['retry', 'replan', 'done', 'delete'] : ['replan', 'delete']
  }
}

export const ACTION_LABELS: Record<Action, string> = {
  start: 'Start',
  approve: 'Approve plan',
  replan: 'Re-plan',
  retry: 'Retry',
  done: 'Mark done',
  delete: 'Delete',
  reopen: 'Reopen',
  merge: 'Merge branch',
  discard: 'Discard branch',
}

/** The card now works in a worktree. */
export const withWorktree = (board: Board, id: number, worktree: Card['worktree'], now: number) =>
  update(board, id, c => touch(c, now, { worktree }, worktree ? `Working on branch ${worktree.branch}` : undefined))

/** A git step on the card's branch went wrong: say so and wait for you. */
export const gitFailed = (board: Board, id: number, what: string, now: number) =>
  update(board, id, c => touch(c, now, { status: `Needs you: ${what}` }, what))

/** The branch was merged or thrown away and its worktree removed. */
export const branchClosed = (board: Board, id: number, how: 'merged' | 'discarded', now: number) =>
  update(board, id, c =>
    touch(c, now, { worktree: undefined, status: how === 'merged' ? 'Done (merged)' : 'Done (branch discarded)' }, `Branch ${c.worktree?.branch ?? ''} ${how}`),
  )

export const fmtTokens = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`)

/** A short account of the board, for the handoff and for Claude. */
export const summary = (board: Board) => {
  const open = board.cards.filter(c => c.stage !== 'done')
  if (!open.length) return 'The agent board has no open cards.'
  return [
    `Agent board (${open.length} open):`,
    ...open.map(c => `- #${c.id} [${STAGE_NAMES[c.stage]}] ${c.title}: ${c.status}${c.agentId ? ' (agent working)' : ''}`),
  ].join('\n')
}

export type WebAction =
  | { op: 'add'; text: string }
  | { op: 'act'; id: number; action: Action }
  | { op: 'model'; id: number; role: Role; model: Model }
  | { op: 'setting'; field: SettingField; value: number | boolean | Model }

export type SettingField = 'maxParallel' | 'autoStart' | 'pauseAtLimit' | 'planModel' | 'executeModel' | 'reviewModel' | 'worktrees' | 'notify' | 'allowlist'

const ACTIONS = Object.keys(ACTION_LABELS) as Action[]
const ROLES: readonly Role[] = ['plan', 'execute', 'review']

/** One line the browser board's server passed on, checked: anything else is dropped. */
export const parseWebAction = (line: string): WebAction | undefined => {
  let a: Record<string, unknown>
  try {
    a = JSON.parse(line) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (!a || typeof a !== 'object') return undefined
  const id = Number(a.id)
  switch (a.op) {
    case 'add':
      return typeof a.text === 'string' && a.text.trim() && a.text.length <= 20_000 ? { op: 'add', text: a.text } : undefined
    case 'act':
      return Number.isInteger(id) && ACTIONS.includes(a.action as Action) ? { op: 'act', id, action: a.action as Action } : undefined
    case 'model':
      return Number.isInteger(id) && ROLES.includes(a.role as Role) && MODELS.includes(a.model as Model)
        ? { op: 'model', id, role: a.role as Role, model: a.model as Model }
        : undefined
    case 'setting': {
      const v = a.value
      if (a.field === 'maxParallel' && Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 8) return { op: 'setting', field: a.field, value: v as number }
      if (a.field === 'pauseAtLimit' && Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100) return { op: 'setting', field: a.field, value: v as number }
      if ((a.field === 'autoStart' || a.field === 'worktrees' || a.field === 'notify' || a.field === 'allowlist') && typeof v === 'boolean') return { op: 'setting', field: a.field, value: v }
      if ((a.field === 'planModel' || a.field === 'executeModel' || a.field === 'reviewModel') && MODELS.includes(v as Model)) {
        return { op: 'setting', field: a.field, value: v as Model }
      }
      return undefined
    }
    default:
      return undefined
  }
}

/** What the browser page needs beside the cards: settings, the pause, each card's buttons. */
export const boardView = (board: Board, settings: Settings, isPaused: boolean, project: string) => ({
  project,
  settings,
  isPaused,
  actions: Object.fromEntries(board.cards.map(c => [c.id, actionsFor(c)])),
})
