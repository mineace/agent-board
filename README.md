# agent-board
a little board for me, no guarantees that it is what you need

A Claude Code plugin: a kanban board where each card is worked by three agents in turn, each in its own context window, so your main conversation stays small.

1. **Plan**: a read-only planner investigates and writes a plan.
2. **Approve**: the card waits for you. Read the plan, then approve it or send it back to re-plan.
3. **Execute**: an executor carries out the approved plan.
4. **Review**: a reviewer checks the work against the plan without changing files and ends with `VERDICT: PASS` or `VERDICT: FAIL`. A failed review sends the card back to Execute with the findings, up to 2 times; after that it waits for you.

## The browser board

While a Claude Code session is open in your project, the board is served at **http://localhost:4848**. Open it in any browser. From there you can:

- add cards (**+ New card**; the first line is the title)
- drag a card to a column it can move to (the allowed columns are outlined)
- open a card to read its request, plan, work summary, review and history, approve or re-plan it, and pick the model for each agent
- change the settings

The page shows **session offline** when no session is serving it. Agents only run while a session is open; the board picks up where it was when you start one again.

From WSL, open `http://localhost:4848` in your Windows browser. It needs Node.js (`node`) on the PATH where Claude Code runs.

## In Claude Code

- `/board` opens the board as a pane (in the terminal, and in the desktop app connected to a local Claude Code), and prints the browser link.
- `/card <what you want>` adds a card.
- Ask Claude to "add a card for …" (tool `add_card`), or "what's on the board" (tool `board_status`).
- A line above the prompt shows what is running, queued, and what needs you.

## Settings

Change them on the page's **Settings**, or in the terminal under `/config` (`agent-board`).

| Setting | Default | |
| --- | --- | --- |
| Cards running at once | 1 | Agents working at the same time |
| Plan new cards automatically | on | Off: new cards wait in Backlog until you press Start |
| Pause at plan usage % | 90 | No new agent starts while the 5-hour or 7-day limit is at or past this (0 = never) |
| Planner / Executor / Reviewer model | Same as session | opus, sonnet or haiku; each card can override |
| Browser board port | 4848 | 0 turns the browser board off |
| Browser board address | 127.0.0.1 | Only this machine can reach it |

The board is saved in `.claude/board.json` in your project (and `.claude/board-view.json` for the page). Add them to your `.gitignore` if you don't want them committed.

Works with [usage-pacer](https://github.com/mineace/claude-usage-meter): a handoff carries the board's open cards to the fresh agent.

## Safety

Agents on the board can use tools, so the browser board only listens on 127.0.0.1, refuses requests addressed to any other host name, and accepts changes only with a token that is new each session and known only to the page it serves. Setting the address to `0.0.0.0` lets anyone on your network read the board.

## Install

At the prompt of a Claude Code session:

```
/plugin install agent-board --marketplace mineace/agent-board
```

Answer `y` to add the marketplace, then pick a scope. From a shell: `claude plugin install agent-board --marketplace mineace/agent-board`.

In the desktop app: click **+** next to the prompt box → **Plugins** → **Add marketplace** with `mineace/agent-board` → **Add plugin**.

To update later: `claude plugin update agent-board`, then `/reload-plugins`.

## Develop

```
claude plugin validate .
claude plugin test .
```
