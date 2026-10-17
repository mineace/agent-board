import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Card, Model, Role, View } from '../types'
import {
  ACTION_LABELS,
  EMPTY,
  MODELS,
  ROLE_OF,
  STAGES,
  STAGE_NAMES,
  act,
  actionsFor,
  addCard,
  boardView,
  branchClosed,
  failed,
  find,
  finished,
  fmtTokens,
  gitFailed,
  modelFor,
  needsYou,
  orphaned,
  parseWebAction,
  readBoard,
  running,
  started,
  summary,
  toStart,
  waiting,
  withWorktree,
  writeBoard,
} from './board'
import type { Action, Settings, WebAction } from './board'
import { isAllowedCall } from './allowlist'
import { AGENTS, taskFor } from './prompts'

const PLUGIN = 'agent-board'
const PANE = 'agent-board'
const boardAtom = atom({ plugin: 'agent-board', key: 'board' } as const, EMPTY)
const viewAtom = atom({ plugin: 'agent-board', key: 'view' } as const, { tab: 'board' } as View)

/** What the module keeps between hooks: the project folder, the settings, the scheduler's state. */
type Ctx = {
  cwd: string
  settings: Settings
  isPumping: boolean
  isPaused: boolean
  web: { port: number; host: string; url?: string; problem?: string }
  /** Cards each running agent has suggested, by agent id: three at most. */
  suggested: Map<string, number>
}

const MAX_SUGGESTIONS = 3
const ROLE_NAMES: Record<Role, string> = { plan: 'planner', execute: 'executor', review: 'reviewer' }

const fileOf = (ctx: Ctx) => `${ctx.cwd}/.claude/board.json`
const viewFileOf = (ctx: Ctx) => `${ctx.cwd}/.claude/board-view.json`

/** Writes what the browser page shows beside the cards. */
async function publish($: EngineInterface, ctx: Ctx, board?: Board) {
  if (!ctx.web.port) return
  const b = board ?? (await read($, boardAtom))
  const project = ctx.cwd.split('/').filter(Boolean).pop() ?? ''
  await $.fs.write(viewFileOf(ctx), `${JSON.stringify(boardView(b, ctx.settings, ctx.isPaused, project))}\n`)
}

async function save($: EngineInterface, ctx: Ctx, fn: (board: Board) => Board) {
  const before = await read($, boardAtom)
  const board = fn(before)
  await update($, boardAtom, () => board)
  try {
    await $.fs.write(fileOf(ctx), writeBoard(board))
  } catch (err) {
    // The cards live on in this session; say so rather than lose them quietly on the next reload.
    $.ui.toast(`Agent board could not save ${fileOf(ctx)}: ${err instanceof Error ? err.message : String(err)}`)
  }
  await publish($, ctx, board)
  for (const c of board.cards) {
    const was = find(before, c.id)
    if (needsYou(c) && was?.status !== c.status) void announce($, ctx, `#${c.id} ${c.title}: ${c.status.replace('Needs you: ', '')}`)
  }
  return board
}

/** A card needs you: a toast here, and a desktop notification unless turned off. */
async function announce($: EngineInterface, ctx: Ctx, text: string) {
  $.ui.toast(`Card ${text}`)
  if (ctx.settings.notify) await $.ui.notify(text, { title: 'Agent board: needs you' }).catch(() => undefined)
}

/** Runs git; never throws (a missing git reads as a failure). */
async function git($: EngineInterface, cwd: string, args: string[]) {
  try {
    const r = await $.process.run(['git', ...args], { cwd, timeoutMs: 120_000 })
    return { ok: r.exitCode === 0, out: r.stdout.trim(), err: (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ') }
  } catch (err) {
    return { ok: false, out: '', err: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Gives the card a worktree of its own (.claude/worktrees/card-N on branch board/card-N) before
 * its executor starts. Not a git repository, or git failing: the card works in the project.
 */
async function ensureWorktree($: EngineInterface, ctx: Ctx, card: Card) {
  if (!ctx.settings.worktrees || card.worktree) return card.worktree
  // The plan may name another repository: the branch is made, and later merged, there.
  const from = card.repo ?? ctx.cwd
  const top = await git($, from, ['rev-parse', '--show-toplevel'])
  const base = await git($, from, ['rev-parse', 'HEAD'])
  const now = await $.clock.now()
  if (!top.ok || !base.ok) {
    await save($, ctx, b => update1(b, card.id, now, `No worktree: ${from} is not a git repository with a commit; working in the project`))
    return undefined
  }
  const path = `${top.out}/.claude/worktrees/card-${card.id}`
  const branch = `board/card-${card.id}`
  await excludeWorktrees($, top.out)
  const exists = (await git($, top.out, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).ok
  const made = await git($, top.out, exists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, base.out])
  if (!made.ok) {
    await save($, ctx, b => update1(b, card.id, now, `No worktree (${made.err}); working in the project`))
    return undefined
  }
  const worktree = { repo: top.out, path, branch, base: base.out }
  await save($, ctx, b => withWorktree(b, card.id, worktree, now))
  return worktree
}

const update1 = (b: Board, id: number, now: number, note: string): Board => ({
  ...b,
  cards: b.cards.map(c => (c.id === id ? { ...c, updatedAt: now, log: [...c.log, { at: now, text: note }].slice(-50) } : c)),
})

/** Keeps the worktrees out of the project's own git status. */
async function excludeWorktrees($: EngineInterface, top: string) {
  const dir = await git($, top, ['rev-parse', '--git-common-dir'])
  if (!dir.ok) return
  const file = `${dir.out.startsWith('/') ? dir.out : `${top}/${dir.out}`}/info/exclude`
  let text = ''
  try {
    text = String(await $.fs.read(file))
  } catch {
    text = ''
  }
  if (!text.split('\n').includes('.claude/worktrees/')) await $.fs.write(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}.claude/worktrees/\n`)
}

/** Commits what the executor left uncommitted, so the reviewer and the merge see all of it. */
async function commitWork($: EngineInterface, card: Card) {
  if (!card.worktree) return
  const dirty = await git($, card.worktree.path, ['status', '--porcelain'])
  if (!dirty.ok || !dirty.out) return
  await git($, card.worktree.path, ['add', '-A'])
  await git($, card.worktree.path, ['commit', '-m', `Card #${card.id}: ${card.title}`])
}

/** Merge or discard a card's branch, then remove its worktree. */
async function closeBranch($: EngineInterface, ctx: Ctx, card: Card, how: 'merge' | 'discard') {
  const wt = card.worktree
  if (!wt) return void $.ui.toast(`Card #${card.id} has no branch to ${how}.`)
  const repo = wt.repo ?? ctx.cwd
  const now = await $.clock.now()
  // Show it working: git can take a while, and a silent button looks broken.
  const working = `${how === 'merge' ? 'Merging' : 'Discarding'} ${wt.branch}…`
  await save($, ctx, b => ({ ...b, cards: b.cards.map(c => (c.id === card.id ? { ...c, status: working } : c)) }))
  if (how === 'merge') {
    await commitWork($, card)
    const ahead = await git($, repo, ['rev-list', '--count', `HEAD..${wt.branch}`])
    if (ahead.ok && ahead.out === '0') $.ui.toast(`${wt.branch} has no commits your branch lacks; nothing to merge.`)
    const merged = await git($, repo, ['merge', '--no-ff', '--no-edit', wt.branch])
    if (!merged.ok) {
      await git($, repo, ['merge', '--abort'])
      await save($, ctx, b => gitFailed(b, card.id, `merge of ${wt.branch} failed (${merged.err}); the branch is kept`, now))
      return
    }
  }
  await git($, repo, ['worktree', 'remove', '--force', wt.path])
  await git($, repo, ['branch', how === 'merge' ? '-d' : '-D', wt.branch])
  await save($, ctx, b => branchClosed(b, card.id, how === 'merge' ? 'merged' : 'discarded', now))
  $.ui.toast(`Card #${card.id}: ${wt.branch} ${how === 'merge' ? `merged into ${repo}` : 'discarded'}.`)
}

async function load($: EngineInterface, ctx: Ctx) {
  let text: string | undefined
  try {
    text = String(await $.fs.read(fileOf(ctx)))
  } catch {
    text = undefined
  }
  const held = await read($, boardAtom)
  const fromFile = readBoard(text)
  // A reload re-reads the file; when it is missing or unreadable, the cards held in memory win.
  const isFileLost = text === undefined || (fromFile.cards.length === 0 && text.trim() !== '' && !text.includes('"cards"'))
  const base = isFileLost && held.cards.length ? held : fromFile
  // A reload re-runs session.start: agents still working keep their cards.
  const alive = new Set(
    (await $.agent.list().catch(() => []))
      .filter(a => a.status === 'pending' || a.status === 'running' || a.status === 'waiting')
      .map(a => a.id),
  )
  const board = orphaned(base, await $.clock.now(), alive)
  await update($, boardAtom, () => board)
  if (base === held) await $.fs.write(fileOf(ctx), writeBoard(board)).catch(() => undefined)
  return board
}

/** Plan usage too high to start an agent: the highest window at or past the pause level. */
const NO_VERDICT = /gave no verdict/i

async function limitHit($: EngineInterface, ctx: Ctx) {
  if (ctx.settings.pauseAtLimit <= 0) return undefined
  const { rateLimits } = await $.session.usage()
  return rateLimits.find(l => l.percentUsed >= ctx.settings.pauseAtLimit)
}

/** Starts agents for waiting cards, as far as the parallel setting and plan usage allow. */
async function pump($: EngineInterface, ctx: Ctx) {
  if (ctx.isPumping) return
  ctx.isPumping = true
  try {
    const hit = await limitHit($, ctx)
    const wasPaused = ctx.isPaused
    ctx.isPaused = hit !== undefined && waiting(await read($, boardAtom)).length > 0
    if (ctx.isPaused !== wasPaused) await publish($, ctx)
    if (hit) return
    for (const card of toStart(await read($, boardAtom), ctx.settings.maxParallel)) {
      const role = ROLE_OF[card.stage]
      if (!role) continue
      const model = modelFor(card, role, ctx.settings)
      const worktree = role === 'execute' ? await ensureWorktree($, ctx, card) : card.worktree
      const task = taskFor({ ...card, worktree }, role)
      const spawn = () =>
        $.agent.spawn({
          prompt: task,
          description: `#${card.id} ${STAGE_NAMES[card.stage]}: ${card.title}`.slice(0, 60),
          subagentType: `${PLUGIN}:${AGENTS[role].name}`,
          ...(model === 'inherit' ? {} : { model }),
          ...(worktree && role !== 'plan' ? { cwd: worktree.path } : {}),
        })
      let spawned = await spawn()
      // Auto mode's classifier can return no verdict for a spawn no prompt asked for; it says to try once more.
      if (spawned.deny !== undefined && NO_VERDICT.test(spawned.deny)) spawned = await spawn()
      const now = await $.clock.now()
      if (spawned.deny !== undefined || !spawned.agentId) {
        const why = spawned.deny !== undefined && NO_VERDICT.test(spawned.deny)
          ? 'auto mode could not evaluate the agent start; press Retry, leave auto mode, or turn on the agents’ safe commands in Settings'
          : (spawned.deny ?? 'the agent did not start')
        await save($, ctx, b => failed(b, card.id, why, now))
      } else {
        const agentId = spawned.agentId
        await save($, ctx, b => started(b, card.id, agentId, now))
      }
    }
  } finally {
    ctx.isPumping = false
  }
}

async function create($: EngineInterface, ctx: Ctx, text: string, source?: string) {
  const now = await $.clock.now()
  let made: Card | undefined
  await save($, ctx, b => {
    const [next, card] = addCard(b, text, now, ctx.settings.autoStart, source)
    made = card
    return next
  })
  void pump($, ctx)
  return made
}

async function press($: EngineInterface, ctx: Ctx, id: number, action: Action) {
  const card = find(await read($, boardAtom), id)
  if (card && (action === 'merge' || action === 'discard')) return closeBranch($, ctx, card, action)
  // A deleted card's worktree folder goes; its branch stays, so the work can still be found.
  if (card?.worktree && action === 'delete') await git($, card.worktree.repo ?? ctx.cwd, ['worktree', 'remove', '--force', card.worktree.path])
  const now = await $.clock.now()
  await save($, ctx, b => act(b, id, action, now))
  if (action === 'delete') await update($, viewAtom, () => ({ tab: 'board' }))
  void pump($, ctx)
}

async function setCardModel($: EngineInterface, ctx: Ctx, id: number, role: Role, model: Model) {
  await save($, ctx, b => ({
    ...b,
    cards: b.cards.map(c => (c.id === id ? { ...c, models: { ...c.models, [role]: model } } : c)),
  }))
}

/** Stores a setting as its /config row would, so it holds in later sessions. */
async function setSetting($: EngineInterface, ctx: Ctx, field: string, value: number | boolean | string) {
  const { deny } = await $.config.set({ key: `${PLUGIN}.${field}`, value })
  if (deny) {
    $.ui.toast(`Could not save ${field}: ${deny}`)
    return
  }
  const s = ctx.settings
  if (field === 'maxParallel') s.maxParallel = Number(value)
  if (field === 'autoStart') s.autoStart = Boolean(value)
  if (field === 'pauseAtLimit') s.pauseAtLimit = Number(value)
  if (field === 'planModel') s.models.plan = value as Model
  if (field === 'executeModel') s.models.execute = value as Model
  if (field === 'reviewModel') s.models.review = value as Model
  if (field === 'worktrees') s.worktrees = Boolean(value)
  if (field === 'notify') s.notify = Boolean(value)
  if (field === 'allowlist') s.allowlist = Boolean(value)
  await publish($, ctx)
  void pump($, ctx)
}

async function openBoard($: EngineInterface, view: View) {
  await update($, viewAtom, () => view)
  return $.ui.open({ id: PANE, title: 'Agent board' })
}

/** Carries out what the browser page asked for, as the pane's buttons would. */
async function applyWeb($: EngineInterface, ctx: Ctx, a: WebAction) {
  if (a.op === 'add') return void (await create($, ctx, a.text))
  if (a.op === 'setting') return setSetting($, ctx, a.field, a.value)
  const card = find(await read($, boardAtom), a.id)
  if (!card) return
  if (a.op === 'model') return setCardModel($, ctx, a.id, a.role, a.model)
  // Only what the card offers now: a page a moment behind cannot skip a step.
  if (actionsFor(card).includes(a.action)) await press($, ctx, a.id, a.action)
}

/** The browser board's server for the session's life: what it prints are the page's requests. */
async function serve($: EngineInterface, ctx: Ctx) {
  const root = $.plugin.root.replace(/\/\.claude-plugin\/?$/, '')
  const server = $.process.spawn({
    argv: ['node', `${root}/web/server.mjs`, String(ctx.web.port), ctx.web.host, fileOf(ctx), viewFileOf(ctx)],
    cwd: ctx.cwd,
  })
  let pending = ''
  try {
    for await (const { stream, text } of server) {
      if (stream === 'stderr') {
        if (text.includes('listening on')) {
          ctx.web.url = `http://localhost:${ctx.web.port}`
          ctx.web.problem = undefined
        } else {
          ctx.web.problem = text.trim()
          $.ui.toast(`Browser board: ${ctx.web.problem}`)
        }
        continue
      }
      pending += text
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const action = parseWebAction(line)
        if (action) await applyWeb($, ctx, action).catch(() => undefined)
      }
    }
  } catch {
    ctx.web.problem = 'it needs Node.js (node) on the PATH where Claude Code runs'
    $.ui.toast(`Browser board off: ${ctx.web.problem}`)
  }
  ctx.web.url = undefined
}

const webLine = (ctx: Ctx) =>
  ctx.web.url ? `Browser board: ${ctx.web.url}` : ctx.web.problem ? `Browser board off: ${ctx.web.problem}` : ''

const asModel = (v: unknown): Model => (MODELS.includes(v as Model) ? (v as Model) : 'inherit')

export const register: Register = (on, options) => {
  const ctx: Ctx = {
    cwd: '.',
    isPumping: false,
    isPaused: false,
    suggested: new Map(),
    web: { port: Math.max(0, Math.floor(Number(options.webPort ?? 4848))), host: String(options.webHost ?? '127.0.0.1') },
    settings: {
      maxParallel: Math.max(1, Number(options.maxParallel ?? 1)),
      autoStart: options.autoStart !== false,
      pauseAtLimit: Number(options.pauseAtLimit ?? 90),
      worktrees: options.worktrees !== false,
      notify: options.notify !== false,
      allowlist: options.allowlist === true,
      models: {
        plan: asModel(options.planModel),
        execute: asModel(options.executeModel),
        review: asModel(options.reviewModel),
      },
    },
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    ctx.cwd = result.cwd
    for (const role of ['plan', 'execute', 'review'] as const) {
      const spec = AGENTS[role]
      await $.agent.register({
        name: spec.name,
        description: spec.description,
        prompt: spec.prompt,
        ...(spec.tools ? { tools: spec.tools } : {}),
        ...(spec.disallowedTools ? { disallowedTools: spec.disallowedTools } : {}),
      })
    }
    await $.command.register({ name: 'board', description: 'Open the agent board' })
    await $.command.register({ name: 'card', description: 'Add a card to the agent board', argumentHint: '<what you want>' })
    await $.tool.register({
      name: 'add_card',
      description:
        'Adds a card to the user’s agent board, where a planner, an executor and a reviewer agent work it in ' +
        'their own contexts (the user approves each plan). Use it when the user asks to add something to the ' +
        'board or to queue work as a card. The first line of text is the title; the rest is the request.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'suggest_card',
      description:
        'Suggests a card for the user’s agent board: it waits in Backlog, labelled with who suggested it, ' +
        'until the user starts it. Board agents use it for work they notice outside their own card. The first ' +
        'line of text is the title; the rest is the request.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'board_status',
      description: 'Lists the open cards on the user’s agent board with their stage and status.',
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })
    const board = await load($, ctx)
    await publish($, ctx, board)
    if (ctx.web.port) void serve($, ctx)
    if (board.cards.some(c => c.stage !== 'done')) void pump($, ctx)
    return result
  })

  on('command.run', { command: 'board' }, async $ => {
    const opened = await openBoard($, { tab: 'board' })
    const where = (await $.session.surfaces()).join(', ') || 'no surface'
    const web = webLine(ctx)
    if (opened.isPlaced) return { text: `Agent board opened.${web ? ` ${web}` : ''}` }
    return { text: `The board pane could not be shown here (${where}: ${opened.reason}).${web ? ` ${web}` : ''}` }
  })

  on('command.run', { command: 'card' }, async ($, e) => {
    const text = (e.args ?? '').trim()
    if (!text) {
      await openBoard($, { tab: 'new' })
      return { text: 'Agent board opened at New card.' }
    }
    const card = await create($, ctx, text)
    return { text: card ? `Card #${card.id} added: ${card.title} (${STAGE_NAMES[card.stage]}).` : 'Card not added.' }
  })

  on('tool.call', { tool: /^mcp__agent-board__add_card$/ }, async ($, e) => {
    const text = String((e as { text?: unknown }).text ?? '').trim()
    if (!text) return { result: 'No card added: the text is empty.' }
    const card = await create($, ctx, text)
    return { result: card ? `Card #${card.id} added in ${STAGE_NAMES[card.stage]}: ${card.title}` : 'No card added.' }
  }).catch(() => ({ result: 'Could not add the card.' }))

  on('tool.call', { tool: /^mcp__agent-board__suggest_card$/ }, async ($, e) => {
    const text = String((e as { text?: unknown }).text ?? '').trim()
    if (!text) return { result: 'No card suggested: the text is empty.' }
    const from = e.agentId ? (await read($, boardAtom)).cards.find(c => c.agentId === e.agentId) : undefined
    const role = from ? ROLE_OF[from.stage] : undefined
    const key = e.agentId ?? 'main'
    const count = ctx.suggested.get(key) ?? 0
    if (count >= MAX_SUGGESTIONS) return { result: `No card added: ${MAX_SUGGESTIONS} suggestions is the limit for one run.` }
    ctx.suggested.set(key, count + 1)
    const card = await create($, ctx, text, from && role ? `the ${ROLE_NAMES[role]} on #${from.id}` : 'Claude')
    return { result: card ? `Card #${card.id} suggested; it waits in Backlog for the user: ${card.title}` : 'No card added.' }
  }).catch(() => ({ result: 'Could not suggest the card.' }))

  // The board's own agents run what their role's allowlist holds without a prompt or auto mode's
  // check; anything else keeps the session's own decision, so it still asks.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    // Off unless the person turned it on: installing the board never skips a check by itself.
    if (!ctx.settings.allowlist || verdict.decision !== 'ask') return verdict
    const input = (e.input ?? {}) as Record<string, unknown>
    if (e.tool === 'Agent' && next.origin.plugin === PLUGIN && String(input.subagent_type ?? '').startsWith(`${PLUGIN}:`)) {
      return { ...verdict, decision: 'allow', reason: 'agent-board starts its own agent' }
    }
    if (!e.agentId) return verdict
    const card = (await read($, boardAtom)).cards.find(c => c.agentId === e.agentId)
    const role = card ? ROLE_OF[card.stage] : undefined
    if (!card || !role) return verdict
    const root = role !== 'plan' && card.worktree ? card.worktree.path : ctx.cwd
    if (!isAllowedCall(role, e.tool, e.input, root)) return verdict
    return { ...verdict, decision: 'allow', reason: `agent-board: on the ${ROLE_NAMES[role]}'s allowlist` }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: /^mcp__agent-board__board_status$/ }, async $ => ({
    result: summary(await read($, boardAtom)),
  })).catch(() => ({ result: 'The board could not be read.' }))

  // With usage-pacer: a handoff carries the board, so the fresh agent knows what is in flight.
  on('tool.call', { tool: /^mcp__usage-pacer__handoff$/ }, async ($, e, next) => {
    const given = String((e as { summary?: unknown }).summary ?? '')
    return next({ ...e, summary: `${given}\n\n${summary(await read($, boardAtom))}` } as typeof e)
  }).catch(($, e, next) => next(e))

  // A card's agent ended: record its answer and move the card on.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId) return done
    const card = (await read($, boardAtom)).cards.find(c => c.agentId === e.agentId)
    if (!card) return done
    const now = await $.clock.now()
    const u = e.usage
    // New tokens are what costs; cache reads (the context re-read on every step) are counted apart.
    const tokens = u ? u.input_tokens + u.output_tokens + u.cache_creation_input_tokens : 0
    const cached = u ? u.cache_read_input_tokens : 0
    ctx.suggested.delete(e.agentId)
    if (card.stage === 'execute' && e.reason === 'answer') await commitWork($, card)
    await save($, ctx, b =>
      e.reason === 'answer' && e.answer.trim() ? finished(b, card.id, e.answer, tokens, now, cached) : failed(b, card.id, e.reason, now, tokens, cached),
    )
    void pump($, ctx)
    return done
  }).catch(($, e, next) => next(e))

  // Plan usage moved: a paused board may go on.
  on('session.measure', async ($, e, next) => {
    if (ctx.isPaused && e.changed.includes('rateLimits')) void pump($, ctx)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const board = await read($, boardAtom)
    const busy = running(board)
    const queued = waiting(board).length
    const needYou = board.cards.filter(c => c.status.startsWith('Needs you')).length
    if (!busy.length && !queued && !needYou) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const parts = [
      ...busy.map(c => `▶ #${c.id} ${STAGE_NAMES[c.stage]}: ${c.title}`),
      queued ? `${queued} queued${ctx.isPaused ? ' (paused: plan usage)' : ''}` : '',
      needYou ? `${needYou} need${needYou === 1 ? 's' : ''} you` : '',
    ].filter(Boolean)
    return (
      <Box>
        <Text dimColor wrap="truncate-end">Board: {parts.join(' · ')} </Text>
        <Button key="open-board" label="Open" onPress={() => openBoard($, { tab: 'board' })} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    // Not every surface has form elements; there the board still shows and /card adds cards.
    const Input = 'Input' in ui ? ui.Input : undefined
    const Select = 'Select' in ui ? ui.Select : undefined
    const board = await read($, boardAtom)
    const view = await read($, viewAtom)
    // A surface that reports no width gets a stacked board.
    const width = e.props.bodyColumns > 0 ? e.props.bodyColumns : 80
    const go = (next: View) => () => void update($, viewAtom, () => next)

    const tabs = (
      <Box gap={1}>
        <Button key="tab-board" label="Board" hotkey="b" variant={view.tab === 'board' ? 'primary' : undefined} onPress={go({ tab: 'board' })} />
        <Button key="tab-new" label="New card" hotkey="n" variant={view.tab === 'new' ? 'primary' : undefined} onPress={go({ tab: 'new' })} />
        <Button key="tab-settings" label="Settings" hotkey="s" variant={view.tab === 'settings' ? 'primary' : undefined} onPress={go({ tab: 'settings' })} />
        {ctx.isPaused && <Text color="yellow">Paused: plan usage at {ctx.settings.pauseAtLimit}%+</Text>}
        {ctx.web.url && <Text dimColor>Browser: {ctx.web.url}</Text>}
      </Box>
    )

    if (view.tab === 'new') {
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          {!Input && <Text dimColor>This app has no text field here: type /card &lt;what you want&gt; instead.</Text>}
          {Input && <Input
            key="new-card"
            label="What do you want? (first line is the title)"
            rows={4}
            autoFocus
            submitLabel="Add card"
            onSubmit={async (text: string) => {
              if (!text.trim()) return
              const card = await create($, ctx, text)
              await update($, viewAtom, () => (card ? { tab: 'card', cardId: card.id } : { tab: 'board' }))
            }}
          />}
          <Text dimColor>
            {ctx.settings.autoStart ? 'The planner starts on it right away; you approve the plan before anything changes.' : 'It waits in Backlog until you press Start.'}
          </Text>
        </Box>
      )
    }

    if (view.tab === 'settings' && Select) {
      const s = ctx.settings
      const modelOptions = MODELS.map(m => ({ value: m, label: m === 'inherit' ? 'Same as session' : m }))
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          <Select
            key="set-parallel"
            label="Cards running at once"
            value={String(s.maxParallel)}
            options={['1', '2', '3'].map(v => ({ value: v }))}
            onSelect={(v: string) => void setSetting($, ctx, 'maxParallel', Number(v))}
          />
          <Select key="set-plan" label="Planner model" value={s.models.plan} options={modelOptions} onSelect={(v: string) => void setSetting($, ctx, 'planModel', v)} />
          <Select key="set-execute" label="Executor model" value={s.models.execute} options={modelOptions} onSelect={(v: string) => void setSetting($, ctx, 'executeModel', v)} />
          <Select key="set-review" label="Reviewer model" value={s.models.review} options={modelOptions} onSelect={(v: string) => void setSetting($, ctx, 'reviewModel', v)} />
          <Select
            key="set-autostart"
            label="New cards"
            value={s.autoStart ? 'on' : 'off'}
            options={[
              { value: 'on', label: 'Start planning right away' },
              { value: 'off', label: 'Wait in Backlog' },
            ]}
            onSelect={(v: string) => void setSetting($, ctx, 'autoStart', v === 'on')}
          />
          <Select
            key="set-worktrees"
            label="Where executors work"
            value={s.worktrees ? 'on' : 'off'}
            options={[
              { value: 'on', label: 'A git branch per card (merge when done)' },
              { value: 'off', label: 'Directly in the project' },
            ]}
            onSelect={(v: string) => void setSetting($, ctx, 'worktrees', v === 'on')}
          />
          <Select
            key="set-notify"
            label="When a card needs you"
            value={s.notify ? 'on' : 'off'}
            options={[
              { value: 'on', label: 'Desktop notification' },
              { value: 'off', label: 'Only show it here' },
            ]}
            onSelect={(v: string) => void setSetting($, ctx, 'notify', v === 'on')}
          />
          <Select
            key="set-allowlist"
            label="Agents' safe commands"
            value={s.allowlist ? 'on' : 'off'}
            options={[
              { value: 'off', label: 'Ask as usual' },
              { value: 'on', label: 'Run without asking (skips auto mode’s check)' },
            ]}
            onSelect={(v: string) => void setSetting($, ctx, 'allowlist', v === 'on')}
          />
          <Select
            key="set-pause"
            label="Pause new agents at plan usage"
            value={String(s.pauseAtLimit)}
            options={['80', '90', '95', '0'].map(v => ({ value: v, label: v === '0' ? 'Never pause' : `${v}%` }))}
            onSelect={(v: string) => void setSetting($, ctx, 'pauseAtLimit', Number(v))}
          />
        </Box>
      )
    }

    const card = view.tab === 'card' ? find(board, view.cardId) : undefined
    if (card) {
      const block = (title: string, text: string | undefined) =>
        text ? (
          <Box flexDirection="column">
            <Text bold>{title}</Text>
            <Text>{text.length > 3000 ? `${text.slice(0, 3000)}…` : text}</Text>
          </Box>
        ) : null
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          <Text bold>
            #{card.id} {card.title}
          </Text>
          <Text dimColor>
            {STAGE_NAMES[card.stage]} · {card.status} · {fmtTokens(card.tokens)} tokens{card.cached ? ` (+${fmtTokens(card.cached)} cached reads)` : ''}
          </Text>
          <Box gap={1} flexWrap="wrap">
            {actionsFor(card).map(a => (
              <Button key={`act-${a}`} label={ACTION_LABELS[a]} variant={a === 'approve' ? 'primary' : undefined} onPress={() => void press($, ctx, card.id, a)} />
            ))}
            <Button key="back" label="Back" onPress={go({ tab: 'board' })} />
          </Box>
          <Box gap={2} flexWrap="wrap">
            {Select && (['plan', 'execute', 'review'] as const).map(role => (
              <Select
                key={`model-${role}`}
                label={`${role === 'plan' ? 'Planner' : role === 'execute' ? 'Executor' : 'Reviewer'} model`}
                value={modelFor(card, role, ctx.settings)}
                options={MODELS.map(m => ({ value: m, label: m === 'inherit' ? 'Same as session' : m }))}
                onSelect={(v: string) => void setCardModel($, ctx, card.id, role, asModel(v))}
              />
            ))}
          </Box>
          {card.source && <Text dimColor>Suggested by {card.source}</Text>}
          {card.repo && <Text dimColor>Works in {card.repo}</Text>}
          {card.worktree && <Text dimColor>Branch {card.worktree.branch} · {card.worktree.path}</Text>}
          {block('Request', card.request)}
          {block('Plan', card.plan)}
          {block('Acceptance criteria', card.criteria?.length ? card.criteria.map(c => `• ${c}`).join('\n') : undefined)}
          {block('Work summary', card.result)}
          {block('Review', card.review)}
          <Box flexDirection="column">
            <Text bold>History</Text>
            {card.log.slice(-8).map(l => (
              <Text dimColor>
                {new Date(l.at).toISOString().slice(11, 16)} {l.text}
              </Text>
            ))}
          </Box>
        </Box>
      )
    }

    // The board: columns side by side when there is room, stacked when narrow.
    const isWide = width >= 96
    const colWidth = isWide ? Math.floor(width / STAGES.length) - 1 : width
    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        {board.cards.length === 0 && <Text dimColor>No cards yet. Press New card (n), or type /card &lt;what you want&gt;.</Text>}
        <Box flexDirection={isWide ? 'row' : 'column'} gap={1}>
          {STAGES.map(stage => {
            const cards = board.cards.filter(c => c.stage === stage)
            if (!isWide && !cards.length) return null
            return (
              <Box key={`col-${stage}`} flexDirection="column" width={colWidth}>
                <Text bold>
                  {STAGE_NAMES[stage]} ({cards.length})
                </Text>
                {cards.map(c => (
                  <Button key={`card-${c.id}`} plain onPress={go({ tab: 'card', cardId: c.id })}>
                    {c.agentId ? '▶ ' : c.status.startsWith('Needs you') ? '! ' : ''}#{c.id} {c.title}
                    <Text dimColor> {c.status}</Text>
                  </Button>
                ))}
              </Box>
            )
          })}
        </Box>
      </Box>
    )
  })
}
