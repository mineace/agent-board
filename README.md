# agent-board
a little board for me, no guarantees that it is what you need

A Claude Code plugin: a kanban board where each card is worked by three agents in turn, each in its own context window, so your main conversation stays small.

1. **Plan**: a read-only planner investigates and writes a plan, ending with a checklist of **acceptance criteria**.
2. **Approve**: the card waits for you. Read the plan, then approve it or send it back to re-plan.
3. **Execute**: an executor carries out the approved plan, on a git branch of its own (`board/card-N`) in a worktree under `.claude/worktrees/`, so your working copy is untouched until you merge.
4. **Review**: a reviewer checks the work against the plan without changing files and marks each acceptance criterion MET or NOT MET, and ends with `VERDICT: PASS` or `VERDICT: FAIL`. A failed review sends the card back to Execute with the findings, up to 2 times; after that it waits for you.

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

If the work belongs in another git repository, the plan says so (`Repository: /path`) and the card's branch is made, and merged, there.

Criteria only you can check (a real device, a deploy, a real account) are marked `[manual]`. The board holds the reviewer to the rest: a PASS with a checkable criterion NOT MET counts as a fail and goes back to Execute. A passed card with manual criteria waits as **Needs you: check by hand**. The reviewer also suggests Backlog cards for problems it finds outside the card and for follow-up work.

When a review passes, the card offers **Merge branch** (merges `board/card-N` into the branch your project has checked out) or **Discard branch**. A merge that conflicts is aborted and the branch kept.

You get a desktop notification whenever a card needs you: a plan to approve, a stopped agent, a review failing twice, a branch to merge.

### Suggested cards

The agents may suggest cards for work they notice outside their own card (a nearby bug, missing tests). Suggestions always land in **Backlog**, labelled with who suggested them ("the executor on #4"), and never start on their own: you go through the backlog and press Start on what you want. Three suggestions per agent run at most.

### Fewer permission prompts (off by default)

With **Agents run safe commands without asking** turned on in Settings, each agent may run its own list of commands without asking, deny-first:

| Agent | Runs without asking |
| --- | --- |
| Planner | reading and searching files, web search and fetch |
| Executor | the above (no web), editing files, `mkdir`/`touch`/`mv`/`cp`, tests and builds (`npm test`/`run`/`install`, `pytest`, `cargo`, `go`, `make`, `tsc`, ...), `git add`/`commit`/`switch` |
| Reviewer | reading files, tests and builds, read-only git |

Everything else still asks you: `rm`, `git push`/`reset`/`checkout`/`clean`, `gh`, `curl`, `npx`, command substitution, redirection, and any path outside the card's folder. In auto mode the listed commands skip auto mode's check, and the board also approves starting its own three agents. That is why it is off until you turn it on: read the lists in `hooks/allowlist.ts` first. Off, the agents ask like anything else in your session.

## Settings

Change them on the page's **Settings**, or in the terminal under `/config` (`agent-board`).

| Setting | Default | |
| --- | --- | --- |
| Cards running at once | 1 | Agents working at the same time |
| Plan new cards automatically | on | Off: new cards wait in Backlog until you press Start |
| Pause at plan usage % | 90 | No new agent starts while the 5-hour or 7-day limit is at or past this (0 = never) |
| Planner / Executor / Reviewer model | Same as session | opus, sonnet or haiku; each card can override |
| A git branch per card | on | Off: the executor works directly in your project |
| Notify when a card needs you | on | A desktop notification, besides the toast |
| Agents run safe commands without asking | off | Each role's allowlist skips the prompt and auto mode's check |
| Browser board port | 4848 | 0 turns the browser board off |
| Browser board address | 127.0.0.1 | Only this machine can reach it |

The board is saved in `.claude/board.json` in your project (and `.claude/board-view.json` for the page). Add them to your `.gitignore` if you don't want them committed. If that file goes missing while a session runs, the cards held in the session are kept and written back.

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
