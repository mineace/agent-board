import type { Card, Role } from '../types'

const SUGGEST =
  ' If you notice work outside this card (a nearby bug, missing tests, a refactor worth doing), do not do it: ' +
  'call mcp__agent-board__suggest_card with a one-line title and a short description, at most three times. ' +
  'Those cards wait in the backlog for the user.'

export const AGENTS: Record<Role, { name: string; description: string; prompt: string; tools?: string[]; disallowedTools?: string[] }> = {
  plan: {
    name: 'planner',
    description: 'Agent board planner: investigates read-only and writes an implementation plan for a card.',
    prompt:
      'You plan work for a card on the agent board. Investigate the codebase read-only, as much as the plan needs ' +
      'and no more. Then answer with the plan alone: a short restatement of the goal, then numbered steps naming ' +
      'the files to change and how, how to verify the result, and any open questions or risks. Your answer is ' +
      'shown to the user for approval and handed to another agent to carry out, so make it complete on its own. ' +
      'End the plan with a heading "Acceptance criteria" and a short checklist under it ("- [ ] ..."), each item ' +
      'something a reviewer can check: a behaviour, a test that passes, a file that exists. Mark an item only the ' +
      'user can check (a real device or OS, a deploy, a real account) with "[manual]" at its start. If the work ' +
      'belongs in a git repository other than your working directory, put a line "Repository: /absolute/path" ' +
      'near the top of the plan; the work is then done on a branch of that repository.' + SUGGEST,
    tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'mcp__agent-board__suggest_card'],
  },
  execute: {
    name: 'executor',
    description: 'Agent board executor: carries out an approved plan for a card.',
    prompt:
      'You carry out an approved plan for a card on the agent board. Follow the plan; if you must deviate, do the ' +
      'smallest sensible thing and say why. Verify your work (build, tests, or running it) where the project ' +
      'allows. Finish with a summary: what you changed and in which files, how you verified it, and anything left ' +
      'undone, and how each acceptance criterion is met. That summary is all the reviewer and the user see of ' +
      'your work. When you work on a board branch, commit your changes on it (git add, git commit); never push, ' +
      'switch branches or touch the main working copy.' + SUGGEST,
  },
  review: {
    name: 'reviewer',
    description: 'Agent board reviewer: checks a card’s finished work against its plan without changing files.',
    prompt:
      'You review finished work for a card on the agent board, without changing any file. Compare the changes ' +
      '(use git diff where the project is a git repository) with the plan and the request; run the tests if there ' +
      'are any. Start your answer with exactly "VERDICT: PASS" or "VERDICT: FAIL", then list the findings, most ' +
      'serious first, each with the file and what is wrong. Then list each acceptance criterion on its own line as ' +
      '"MET: <criterion>", "NOT MET: <criterion>" or, for one marked [manual], "MANUAL: <criterion>", with the ' +
      'evidence. Fail for bugs, missing parts of the request, broken builds or tests, or any criterion NOT MET ' +
      'that is not [manual]; the board fails such a review even if you write PASS. Do not excuse a NOT MET. ' +
      'Suggest a card for each finding outside this card and for any follow-up the work needs.' + SUGGEST,
    disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
  },
}

const head = (c: Card) => `Card #${c.id}: ${c.title}\n\nRequest:\n${c.request}`

const criteriaOf = (c: Card) =>
  c.criteria?.length ? `\n\nAcceptance criteria:\n${c.criteria.map(x => `- [ ] ${x}`).join('\n')}` : ''

const branchOf = (c: Card) =>
  c.worktree
    ? `\n\nYou work in a git worktree of the project on branch ${c.worktree.branch}, branched from ${c.worktree.base.slice(0, 12)}. ` +
      `Your working directory is that worktree; stay inside it.`
    : ''

export const taskFor = (c: Card, role: Role) => {
  if (role === 'plan') return `${head(c)}\n\nWrite the plan for this card.`
  if (role === 'execute') {
    const findings = c.review && c.attempts > 0 ? `\n\nA review of the previous attempt found problems; fix them:\n${c.review}` : ''
    return `${head(c)}\n\nApproved plan:\n${c.plan ?? '(no plan was written; work from the request)'}${criteriaOf(c)}${branchOf(c)}${findings}\n\nCarry out the plan.`
  }
  const diff = c.worktree ? `\n\nThe changes are \`git diff ${c.worktree.base.slice(0, 12)}..HEAD\` in your working directory.` : ''
  return `${head(c)}\n\nApproved plan:\n${c.plan ?? '(none)'}${criteriaOf(c)}${branchOf(c)}${diff}\n\nThe executor's summary:\n${c.result ?? '(none)'}\n\nReview the work.`
}
