import type { Role } from '../types'

/**
 * What each board agent may run without a prompt, deny-first after AgentBoard's tool allowlist:
 * anything not listed (rm, git push/reset/checkout/clean/rebase, gh, curl, sudo, ...) is left to
 * the session's own permission decision, so it still asks you.
 */

const READ_TOOLS = ['Read', 'Glob', 'Grep', 'LS']
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

/** Shell commands by their first word (and, where given, the subcommands allowed). */
type CommandRule = true | readonly string[]

const READ_COMMANDS: Record<string, CommandRule> = {
  ls: true, cat: true, head: true, tail: true, wc: true, grep: true, rg: true, find: true, pwd: true,
  echo: true, which: true, diff: true, stat: true, file: true, tree: true, sort: true, uniq: true,
  git: ['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'branch', 'merge-base'],
}

const BUILD_COMMANDS: Record<string, CommandRule> = {
  npm: ['test', 'run', 'ci', 'install'], pnpm: ['test', 'run', 'install'], yarn: ['test', 'run', 'install'],
  bun: ['test', 'run', 'install'], node: true, python: true, python3: true, pytest: true, tsc: true,
  jest: true, vitest: true, eslint: true, prettier: true, ruff: true, mypy: true, make: true,
  cargo: ['build', 'test', 'check', 'run', 'fmt', 'clippy'], go: ['build', 'test', 'vet', 'run', 'fmt'],
}

const WRITE_COMMANDS: Record<string, CommandRule> = {
  mkdir: true, touch: true, mv: true, cp: true,
  git: ['add', 'commit', 'switch', 'mv'],
}

const COMMANDS: Record<Role, Record<string, CommandRule>[]> = {
  plan: [READ_COMMANDS],
  execute: [READ_COMMANDS, BUILD_COMMANDS, WRITE_COMMANDS],
  review: [READ_COMMANDS, BUILD_COMMANDS],
}

// Forms that change or delete things, though their command is listed.
const RISKY: Record<string, RegExp> = {
  git: /(^|\s)(-d|-D|--delete|-m|-M|--move|-f|--force|--hard|-c)(\s|=|$)/,
  find: /(^|\s)(-exec|-execdir|-ok|-okdir|-delete|-fprint\S*|-fls)(\s|$)/,
}

// `git commit -m` is the listed git form whose -m is a message, not a rename.
const isRisky = (cmd: string, sub: string, part: string) =>
  cmd === 'git' && sub === 'commit' ? /(^|\s)(--amend|-f|--force)(\s|$)/.test(part) : (RISKY[cmd]?.test(part) ?? false)

// A reviewer checks; it does not rewrite files through a formatter.
const FIXES = /(^|\s)(--write|--fix|-w)(\s|=|$)/

const UP = /(^|\/)\.\.(\/|$)/

function inside(path: unknown, root: string) {
  if (typeof path !== 'string' || UP.test(path) || path.startsWith('~')) return false
  const base = root.replace(/\/$/, '')
  return !path.startsWith('/') || path === base || path.startsWith(`${base}/`)
}

const unquote = (word: string) => word.replace(/^['"]|['"]$/g, '')
const isOutside = (word: string, root: string) =>
  UP.test(word) || ((word.startsWith('/') || word.startsWith('~')) && !inside(word, root))

/** True when every part of a shell command is listed for the role and names no path outside `root`. */
export const isAllowedCommand = (role: Role, command: string, root: string) => {
  // Substitutions, redirections and escapes can hide another command: those go to the prompt.
  if (!command.trim() || /[`<>\\\n]|\$\(|\$\{/.test(command)) return false
  return command.split(/&&|\|\||;|\|/).every(part => {
    const words = part.trim().split(/\s+/).filter(Boolean)
    if (words.some(w => isOutside(unquote(w), root))) return false
    if (words[0] === 'cd' && words.length <= 2) return true
    const [cmd = '', sub = ''] = words
    // A command may be in several lists (git reads, git commits): any one allowing it is enough.
    if (!COMMANDS[role].some(list => list[cmd] === true || (Array.isArray(list[cmd]) && list[cmd].includes(sub)))) return false
    if (role === 'review' && FIXES.test(part)) return false
    return !isRisky(cmd, sub, part)
  })
}

/**
 * Whether a board agent's tool call may run without asking. `root` is the folder the card works in
 * (its worktree, or the project); edits outside it are not approved.
 */
export const isAllowedCall = (role: Role, tool: string, input: unknown, root: string) => {
  const args = (input ?? {}) as Record<string, unknown>
  // Reads stay in the card's folder: a read of ~/.ssh still asks.
  if (READ_TOOLS.includes(tool)) return [args.file_path, args.path].every(p => p === undefined || inside(p, root))
  if (role === 'plan' && (tool === 'WebFetch' || tool === 'WebSearch')) return true
  if (role === 'execute' && EDIT_TOOLS.includes(tool)) return inside(args.file_path ?? args.notebook_path, root)
  if (tool === 'Bash' && typeof args.command === 'string') return isAllowedCommand(role, args.command, root)
  return false
}
