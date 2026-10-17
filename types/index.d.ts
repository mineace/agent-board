export type Stage = 'backlog' | 'plan' | 'approve' | 'execute' | 'review' | 'done'

export type Role = 'plan' | 'execute' | 'review'

export type Model = 'inherit' | 'opus' | 'sonnet' | 'haiku'

export type Card = {
  id: number
  title: string
  request: string
  stage: Stage
  /** Model per role; absent means the board's setting. */
  models: Partial<Record<Role, Model>>
  plan?: string
  result?: string
  review?: string
  /** What the card is doing or waiting for, one line. */
  status: string
  /** The agent working on it, while one is. */
  agentId?: string
  /** Executor runs after a failed review. */
  attempts: number
  tokens: number
  createdAt: number
  updatedAt: number
  log: { at: number; text: string }[]
}

export type Board = { nextId: number; cards: Card[] }

export type View = { tab: 'board' | 'new' | 'settings' | 'card'; cardId?: number }

declare module 'claude-code' {
  interface PluginState {
    'agent-board': { board: Board; view: View }
  }
}
