import type { Card, Role } from '../types'

export const AGENTS: Record<Role, { name: string; description: string; prompt: string; tools?: string[]; disallowedTools?: string[] }> = {
  plan: {
    name: 'planner',
    description: 'Agent board planner: investigates read-only and writes an implementation plan for a card.',
    prompt:
      'You plan work for a card on the agent board. Investigate the codebase read-only, as much as the plan needs ' +
      'and no more. Then answer with the plan alone: a short restatement of the goal, then numbered steps naming ' +
      'the files to change and how, how to verify the result, and any open questions or risks. Your answer is ' +
      'shown to the user for approval and handed to another agent to carry out, so make it complete on its own.',
    tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
  },
  execute: {
    name: 'executor',
    description: 'Agent board executor: carries out an approved plan for a card.',
    prompt:
      'You carry out an approved plan for a card on the agent board. Follow the plan; if you must deviate, do the ' +
      'smallest sensible thing and say why. Verify your work (build, tests, or running it) where the project ' +
      'allows. Finish with a summary: what you changed and in which files, how you verified it, and anything left ' +
      'undone. That summary is all the reviewer and the user see of your work.',
  },
  review: {
    name: 'reviewer',
    description: 'Agent board reviewer: checks a card’s finished work against its plan without changing files.',
    prompt:
      'You review finished work for a card on the agent board, without changing any file. Compare the changes ' +
      '(use git diff where the project is a git repository) with the plan and the request; run the tests if there ' +
      'are any. Start your answer with exactly "VERDICT: PASS" or "VERDICT: FAIL", then list the findings, most ' +
      'serious first, each with the file and what is wrong. Fail only for real problems: bugs, missing parts of ' +
      'the request, or broken builds or tests.',
    disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
  },
}

const head = (c: Card) => `Card #${c.id}: ${c.title}\n\nRequest:\n${c.request}`

export const taskFor = (c: Card, role: Role) => {
  if (role === 'plan') return `${head(c)}\n\nWrite the plan for this card.`
  if (role === 'execute') {
    const findings = c.review && c.attempts > 0 ? `\n\nA review of the previous attempt found problems; fix them:\n${c.review}` : ''
    return `${head(c)}\n\nApproved plan:\n${c.plan ?? '(no plan was written; work from the request)'}${findings}\n\nCarry out the plan.`
  }
  return `${head(c)}\n\nApproved plan:\n${c.plan ?? '(none)'}\n\nThe executor's summary:\n${c.result ?? '(none)'}\n\nReview the work.`
}
