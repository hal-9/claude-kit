# story-loop

**One command takes a Shortcut story or a GitHub issue to a reviewed PR and through its review. You sign the plan
at the start, watch it on a live board, and merge; the run closes by writing down what it learned.**

https://github.com/user-attachments/assets/2b6288d5-f57a-4f69-ad09-538e4a70fcab

```
/story-loop SC-12345        # a Shortcut story
/story-loop gh-123          # a GitHub issue (or paste its URL)
/story-loop review SC-12345 # later, in any session: pick up a colleague's review of that run's PR
```

> Status: 0.14, experimental, in a supervised pilot. What has been checked, and
> how, are three different things:
>
> - **Fixture tests** (`node --test tests/*.test.mjs`): the parts on their own,
>   against real git, local bare remotes, a fake `gh` and a fake `claude`.
> - **Runtime smoke tests**: the board in a real browser; nothing else yet.
> - **Real story validation**: none yet. The whole loop has not carried a real
>   story, and nothing here has run against the real GitHub, Copilot or CI.
>
> Use it supervised, on a feature branch, and review and merge as you would
> any PR. A green test suite is not a claim that it is bulletproof.

## What happens

```mermaid
flowchart LR
  A[1 Contract] --> B[2 Build] --> Q[3 Quality gate] --> C[4 Test review] --> D[5 Browser verify]
  D --> E[6 Second review] --> F[7 Push] --> G[8 Copilot review] --> H[9 Fix comments] --> I[10 Report]
  I --> K[11 Retro] -. run ends; later: /story-loop review .-> J[12 Human review]
  Q -. slop signal .-> B
  C -. missing test .-> B
  D -. a check fails .-> B
  E -. real defect .-> B
  H -. bigger fix .-> B
  J -. reviewer asks for a change .-> B
```

| # | Stage | What the agent does | What proves it |
| --- | --- | --- | --- |
| 1 | Contract | From the story (`start-story`) or the issue: drafts the PR description, asks about gaps, proposes a lane by how costly a mistake would be, shows the plan on one page, opens the draft PR | **Your sign-off**, with the lane, the hard decisions and the feature-flag answer recorded |
| 2 | Build | Splits the plan into tasks; worker agents on Haiku, Sonnet or Opus build test by test through the public interface, each told which existing pattern to copy; a bug whose cause is not obvious is first reproduced by a failing command | Every task accepted, everything committed |
| 3 | Quality gate | Runs the repo's linters on the changed files and reads the added lines for slop: a linter switched off, a skipped test, a comment excusing a shortcut, code over the lane's budget (test lines are reported beside it, not counted) | Lint clean on this exact code; every signal removed or accepted with a reason |
| 4 | Test review | Breaks each changed line on purpose, in throwaway copies (several at once where the tests share nothing), and checks a test notices. How many mutants and which files follow the lane: 10 front-end mutants on light, 25 on standard, all on heavy. Tests it adds go through the quality gate again at once | Mutation results for this exact code: killed, survived, invalid, timed out |
| 5 | Browser verify | A second agent that has not seen the code checks every Test Step in a real browser, booting and logging in from the repo's `.devloops` `uiReview` recipe when there is one, and failing a check whose server log shows an error | Every check of the matrix you approved, once, with a real screenshot |
| 6 | Second review | Another model tries to break the work, and names what the next change would copy: Codex by default, any reviewer CLI you name, or a fresh Claude on another model, flagging behaviour no goal asks for too. Alongside it, a standards angle that judges the diff against the repo's documented rules (CLAUDE.md, AGENTS.md, review checklists) and common smells, and every review angle with a prompt in the repo's `.devloops` file (the dev-loops config), each allowed to leave the diff | Every finding with a severity, one finding per defect however many sources named it: fixed with its commit, rejected with a reason, or parked for you |
| 7 | Push | Publishes the checked commit to the story branch, nothing else | The remote read back at that commit |
| 8 | Copilot review | Marks the PR ready for review (so CI that skips drafts runs), requests GitHub Copilot's review and waits for it in the background, with a deadline | A Copilot review of exactly that commit |
| 9 | Fix comments | Triages every comment, answers every thread from one map (fixed, rejected, deferred) and resolves only the fixed ones; any code change goes back to Build | Every comment settled |
| 10 | Report | Posts the results on the PR, what needs your decision first, with the user flow as a chart and the evidence where you chose to share it | Required CI green on the final commit; one report comment |
| 11 | Retro | Names a lesson for every correction of the run and the check that would catch its kind next time: a lint rule, a type, a test, an API that makes the mistake impossible, a rule for the standards reviewer, and prose only as the last resort; a check the repo already has but never runs comes first | A lesson for every fixed finding and every round sent back; the run's line in the ledger. The run ends here, so the checkout is free for the next story |
| 12 | Human review | A follow-up of the ended run, started when you say so (`/story-loop review <story>`): fetches what human reviewers wrote, triages it like any review, sends real defects back to Build (then the stages after it and the retro run again) | Every reviewer comment settled, and the PR merged or closed **by a human** |

A later stage can send work back to Build, twice at most. Then it stops and
shows you instead of trying a third time. Going back makes the earlier tests,
browser checks and reviews stale: they run again on the new code, and the old
results stay in the run's history. On a later attempt the browser re-runs every
approved check unless only tests changed (then earlier passes carry over, marked
*carried*), every mutant runs again, and the second review looks only at the fix
when it stays in the files of the findings sent back and is at most a quarter of
the branch. Tests committed after a review get a delta review of their own.

## What stays yours

- **Signing the contract.** Nothing is built before you approve the plan.
- **Decisions.** Design questions and anything that contradicts the PR
  description are parked for you, never guessed.
- **Approval and merge.** The agent marks the PR ready for review once, right
  after the push, and never merges. A hook refuses a merge and any other way of
  marking it ready.
- **Building the checks.** The retro proposes them; each one is its own story,
  started by you.

## The ledger: how the loop learns

Every run leaves one line in the repository's ledger (`.git/story-loop/ledger.jsonl`, shared by every worktree), also a run that was
dropped half way, and whether or not diagnostics were on: the factory version,
the lane, where work was sent back and why, findings by source and verdict,
how often each worker tier was returned, the lessons of the retro, and tokens
by stage and model.

```bash
node <plugin>/skills/story-loop/scripts/loop.mjs ledger
```

It prints the lessons by how many runs hit them (two or more: build that check
now), where runs go back, which tier keeps being returned, and the share of
tokens spent checking the work. Change the loop from what this shows, not from
how one run felt.

The lessons also flow forward: `loop.mjs ledger --lessons` prints them alone,
and the contract stage hands them to the advisor as known pitfalls, so a new
plan names what guards against a mistake an earlier run was corrected for.

A lesson that recurs (two or more runs) becomes work: at the retro,
`github.mjs promote <pattern> --dry-run` drafts a GitHub issue with every run
and proposal behind it, and on the human's yes `github.mjs promote <pattern>`
files it, once per pattern (an issue with the same title, open or closed, is
reported instead). A later story-loop run can take that issue like any other.

Once a check lands, its pattern is handled: `loop.mjs handled <pattern> "<PR>"`
by hand, or on its own when `promote` finds the issue closed as completed
(`.git/story-loop/handled.json`). The ledger then shows where the check landed,
and flags any run started after that which still hit the pattern: the check did
not hold.

What it is not yet: nothing scores finished runs on its own, nothing replays
old tasks against other models, and no agent opens a PR against the loop's own
instructions. Those need a ledger with real runs in it first.

## The board

It opens in your browser when a story starts.

- **Top:** the story and the PR as links, then the twelve stages as a graph,
  the current one alive, and an arrow when work is sent back, with the
  reason. Right under it: who is working on what right now, and the tasks.
- **Three cards**, each the gist at a glance; click one for the detail in a
  popup:
  - *Review findings:* how many are settled, a bar by verdict, and the one
    that needs your call. The popup filters by verdict.
  - *Tested in the browser:* how many checks pass, the latest screenshots and
    each Test Step's verdict. The popup shows every check with its
    screenshots.
  - *The change:* files and lines by area and the mutants killed. From the
    report stage on, **Walk through this change** opens the whole change full
    screen: a summary, one chapter per Test Step, each change with a note
    beside its lines. Every note says whether a test or check proves it or it
    is the agent's reading, and a dot in the margin shows whether a test fails
    when that line changes. Code wraps; nothing scrolls sideways. It ends with
    a short quiz, so you still know your code.
  - *The learning loop:* before the retro, the pitfalls earlier runs taught
    (the plan was checked against them); after it, this run's lessons, each
    with how many runs hit it. A lesson that keeps coming back is marked: it
    is worth a check of its own. The popup lists every pattern in the ledger.
- **After the retro** the board keeps showing the run, headed *Over to
  review*, with the command to copy for when the PR has comments:
  `/story-loop review <story>`.
- **Usage** (top right): tokens by stage and model, and what they would cost
  at Claude API list prices. **Log** appears only for a run started with
  `--diagnostics`: every recorded event, filterable.
- **Tell the agent:** under any change in the walkthrough, finding or check you can write
  "this is wrong" or "do it differently". A working agent picks the note up at
  its next step. If the agent is idle, **Copy handover note** gives you the
  text to paste into Claude. A copied note stays open until the agent has
  received and handled it, so nothing is lost if you never paste it.
- **Honest states:** checks count against the matrix you approved (1 of 20,
  never 1 of 1); evidence from older code is marked stale; a stage that cannot
  go on says why.

See it without a story:

```bash
node skills/story-loop/board/server.mjs --demo
```

Then open http://127.0.0.1:4317. It replays a scripted run in about 40 seconds.

## Get started

### 1. Install

```
/plugin install story-loop --marketplace hal-9/claude-kit
```

Start a new Claude Code session afterwards, so the hooks load.

Developed and tested with Claude Code 2.1.317. The one-step `--marketplace`
install above is documented for 2.1.275 and later; that says nothing about
the rest. What the plugin needs from Claude Code: plugin hooks for
`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `SubagentStart`,
`SubagentStop`, `SessionStart`, `SessionEnd`, `PreModelSwitch` and
`PostModelSwitch`; `session_id` (and `agent_id` for workers) in hook input;
plugin-defined agents with a fixed model; and `claude -p --tools` for the
board's explainer. On an older version some of these do nothing, silently:
the run still works, with weaker guards.

### 2. Let it check your machine

In the repo you work in:

```
/story-loop setup
```

It checks every prerequisite, tells you what is missing and what it is for,
and walks you through each fix. It installs nothing behind your back and never
asks you to paste a password. You can run the check alone too:

```bash
node <plugin>/skills/story-loop/scripts/doctor.mjs
```

### 3. Run a story (or continue one)

```
/story-loop SC-12345        # a Shortcut story
/story-loop gh-123          # a GitHub issue (or paste its URL)
```

Switch the session to Opus 5.5 first (`/model`): the conductor runs on it, and the hook refuses a run it can see starting on another model. Pick a small story with a page to test for the first run.

A run belongs to the session that drives it. To continue in a new session, run
`/story-loop` again there: it takes the run over with `loop.mjs acquire` once
the old session has been quiet for 15 minutes (or at once, when you say so).

To run a second story while one is active, `/story-loop SC-12346` sets up a
worktree beside the checkout (`<repo>-story-loop/sc-12346`) with its untracked
files and its own board and app ports. Open a new session in that folder and
run `/story-loop SC-12346` there. Both runs write to one ledger. When the test
database is shared, it says so: the two runs then must not run Rails specs at
the same time.

### 4. Record a run (optional, for the pilot)

To study a run afterwards, ask for a recorded one. It is off by default.

```
/story-loop SC-12345 and record diagnostics
```

or, by hand, in the repo:

```bash
node <plugin>/skills/story-loop/scripts/loop.mjs init SC-12345 --diagnostics   # from the start
node <plugin>/skills/story-loop/scripts/loop.mjs diagnostics on                # or part way; what came before is marked missing
node <plugin>/skills/story-loop/scripts/loop.mjs diagnostics status
node <plugin>/skills/story-loop/scripts/loop.mjs diagnostics export            # the active run
node <plugin>/skills/story-loop/scripts/loop.mjs diagnostics export --run <run id>   # any earlier run, also after `end` or a new story
```

The export is one folder (it prints where): `summary.md`, `manifest.json`,
`events.jsonl`, the run state and the run's files with their hashes. Give that
folder to an agent and have it read `summary.md` first; it ends with the
prompt for the analysis. Add `--screenshots` to include the browser
screenshots.

- Recording changes no decision. If a record cannot be written the run goes
  on, warns once, and the export says the recording is incomplete.
- Secrets (tokens, passwords, cookies, credentials in URLs) are redacted
  before anything is written. Full transcripts are never recorded.
- Nothing is uploaded or posted. It stays under
  `.start-story/<story>/diagnostics/<run id>/`, which is gitignored with the
  rest of `.start-story/`.
- It says what it does not know: a tool call with no recorded end, a helper
  that never reported, a line cut off part way, a version that could not be
  read. It does not fill those in.

## What you need

`/story-loop setup` checks the first nine for you. Without Codex the second review still runs, by a fresh Claude on another model; that is weaker than a model from another vendor, and the report says which reviewer was used.

| Needed | For | Get it |
| --- | --- | --- |
| Node 20+ | every script | `brew install node` |
| GitHub CLI, signed in | PR, push, Copilot review | `brew install gh`, `gh auth login` |
| Shortcut CLI 5+ (Shortcut stories only) | reading the story, moving the card | `npm i -g @shortcut-cli/shortcut-cli`, `short install` |
| `start-story` skill in the repo (Shortcut stories only) | the contract stage | synced with the shared skills |
| `modern-web-guidance` skill | build: front-end briefs carry current web-platform patterns; without it the hook refuses briefs that name HTML, CSS or client-side JS files | `npx skills add GoogleChrome/modern-web-guidance` (Claude Code, global) |
| `.start-story/` gitignored | run files and screenshots stay out of the PR (a blocker if not) | one line in `.gitignore` |
| Signed commits, if the repo requires them | the publisher refuses unsigned commits when signing is on; setup signs a throwaway commit to prove it works | the repo's signed-commits guide |
| Codex plugin, signed in (recommended, not required) | the strongest second review: a model from another vendor | `/plugin install codex@openai-codex`, `/codex:setup` |
| Figma MCP, signed in (stories that link a Figma frame) | verify compares the page with the frame its check names; build reads sizes and colours from it | `claude mcp add --scope user --transport http figma https://mcp.figma.com/mcp`, then sign in from `/mcp` |
| A browser the agent can drive | browser verify | Chrome with the Claude extension, **or** the BrowserOS app running |
| A test user in that browser | logging in on previews and staging | sign in as a test user, or save its login in the browser; the agent does not type passwords on non-local sites |
| Copilot review enabled on the repo | the Copilot review | repository settings |
| The app boots in the test environment | browser verify | your project's usual setup |
| A linter for the files you change (optional) | the quality gate runs it; without one the gate reads the diff for slop signals only | your project's usual linters |
| A local server of the app, started from the checkout | browser verify tests the code under review only when the page is served from it; a staging or preview site usually still has older code at that point | your project's dev server; a deployment counts only when it reports the commit it serves |

No browser reachable? The loop does not skip the browser check. It stops and
asks you to start one.

## Who thinks with what

| Role | Model | Why |
| --- | --- | --- |
| Conductor: runs the loop, keeps the overview, checks every result | Opus 5.5 | care and overview, at half Fable's price per token |
| Advisor, read-only: the contract, triage of serious findings, the retro, the fallback reviewer | Fable 5.2 | the few calls where one wrong judgment costs a build round or ships a bug |
| Hard or delicate tasks, the browser verifier | Opus (max effort for the hardest) | needs care, not the overview |
| Standard feature work | Sonnet | clear requirements, few files |
| Mechanical edits, running suites | Haiku | nothing to decide |

This is enforced, not suggested. The four workers carry their model in their
definition. A hook refuses any other delegation that does not name Opus,
Sonnet or Haiku, refuses to start a run from a session on another model, and
blocks switching the session away from Opus while a run is active (a switch
would also drop the prompt cache). The models are three lines in
`skills/story-loop/scripts/graph.json`.

One limit: Claude Code tells hooks the session's model only at session start
and on a switch. If it reports neither, the check cannot see the model and
lets the run start.

## What it will not do

| Promise | How | Where it ends |
| --- | --- | --- |
| Publish only the story branch: no force, no tags, no other refs | Raw `git push` is refused by a hook; `publish.mjs` pushes `<checked commit>:refs/heads/<branch>` to a remote with exactly one push URL, then reads it back | A disguised command (`sh -c "$(…)"`) or another tool can get past a hook that reads command text; branch protection on GitHub is the firm boundary |
| Publish only to the run's repository, never to the base or default branch | Before the first write the push URL is parsed whole as `owner/name` (scp-style `git@github.com:`, `ssh://git@github.com/` or `https://github.com/`, no port, query, fragment or encoded characters; a URL that merely contains `github.com/owner/name` is refused) and compared with the run's repository; the story branch is compared with the recorded base and with the default branch the remote reports | Only github.com URLs are recognised; an SSH host alias or GitHub Enterprise host is refused, not supported. Forks are refused |
| Never merge; the PR leaves draft only through the guarded step | The hook refuses `gh pr merge`, `gh pr ready` and the GraphQL/REST spellings, with or without `--repo`. `github.mjs ready` decides from local state before any GitHub call: a publication from the push stage (never the contract's draft push), HEAD equal to it, every gate holding | Same as above for raw commands |
| A stage looks done only when it is | Every pass is checked against its evidence (`loop.mjs passProblem`); browser checks against the approved matrix, screenshots as complete image files in the evidence folder; the last stage checks everything again | The agent writes the evidence files; the checks catch omissions, stale and fake files, not a deliberate forgery. Screenshots are checked to be whole files, not to show what they claim |
| One gate decision, everywhere | `gateProblem` decides whether each gate holds for the code now: its accepted result exists and reads as what it claims, its outcome meets the policy, its identity (code tree, the diff's merge base, lane, check list, environment, review request) is the current one, no newer replacement of it is running, failed or was interrupted, and every waiver is recorded for these results. Stage passes, the publisher, `github.mjs ready`, the report, `loop.mjs status` and the board all ask it | A stage stays `passed` in the history; whether it still holds is this decision. Evidence recorded before 0.21 (no merge base, free-text reviews) is not kept green: run it again |
| A failed or pending rerun is not hidden by an earlier pass | Each helper run claims its units (quality: one; mutate: each file) under a number that only grows; the newest claim decides, a result of an older one changes nothing, and a newest claim that is running or failed leaves the gate unsatisfied | A rerun is a replacement only when recorded; `--explore` runs change nothing by design |
| A retargeted base re-decides the diff | Quality, mutants, the review request and the walkthrough record the merge base of their diff; `loop.mjs put base` lists what no longer holds, and helpers refuse a `--base` other than the run's | A base tip that moves without changing the merge base changes nothing |
| Old evidence never passes new code | Browser results carry a request id made before the browser ran (run, attempt, check list, environment, code tree); a review is recorded under a request made before the reviewer ran, for the code tree that request named; a later commit makes all of it stale, and the publisher refuses to push such a commit | Equivalent code reached by a different tree counts as new; the same tree under another commit counts as the same code. Code changed while the browser ran and put back before the pass is not seen. An old review answer that was never recorded could still be handed in under a new request |
| Work that finishes late changes nothing | Mutants, the Copilot wait, CI, comments, the report and the publisher note the run and attempt they started in and are checked against it, under the lock, before their result is recorded; a late result is kept under `stale/`; `end` asks running helpers to stop | A push or a comment that already reached GitHub stays there: it is recorded for the run that made it and has to be reconciled by hand |
| A browser pass means the reviewed code | The environment is recorded before the browser runs: a local server from the checkout, or a deployment with the commit it reports (refused when that is another commit). Every result names its final URL, its environment, its step and case | A local server is the agent's word that it runs this checkout. A deployment nothing ties to the code passes only on your word and is marked "not exact code" on the board and in the report |
| Mutation results mean something | The scope is the diff, not the files the agent names; a kill needs a mutant that was checked to parse and a failure the runner's report attributes to it (an assertion, or an error in a test body that the unmutated code, run again, does not have); a dependency outage, a failed hook on clean code, a file that no longer loads or no tests selected is never a kill; survivors, timeouts and mutants not run each need a recorded reason | Adapters for node:test, Jest, Vitest and RSpec; anything else runs only with an explicit `--adapter exit`, whose failures are each rechecked against clean code. A recheck narrows doubt, it does not rule out every flake. Mutants are textual, one operator per line, at most `--max` per call; ts/tsx/jsx are checked only with the project's `typescript` 5.x (7.x has no API for it: unverified); templates and styles are named, not mutated |
| Mutation runs share the machine | Slots are opened for runnable mutants only, from one budget shared by every mutate call in every checkout of the repository (`STORY_LOOP_MUTATION_CAPACITY`, default 4; `--weight` for runners with their own workers); a lease is removed only by the owner that holds its token | The budget counts slots, not CPU; a test command that forks its own workers needs `--weight` or a single-worker flag |
| Slop is decided, not waved through | `quality.mjs` reads only the lines this change added, for the code tree it ran on; lint must exit 0; each signal needs a recorded reason, and a diff over the lane's budget stands only with a `human:` reason | Signals are textual, one pattern per kind: they catch a linter switched off, a skipped test and an excusing comment, not a bad design. The lint command is the agent's choice; a linter the repo does not have is not run |
| A reviewer's comment is not lost | `github.mjs human-comments` fetches every top-level thread and review body by a human; the round passes only when each has a settled finding and that fetch saw the PR merged or closed | A comment written after that fetch is not seen. Issue-level comments on the PR are not fetched |
| A second-review finding is not lost | Reviewers and angles answer in one JSON schema (`story-loop.review/1`); `loop.mjs review` refuses malformed answers and turns every finding into a finding to triage with its source id; the stage holds until every requested angle completed or said no_op and every source finding is triaged or marked a duplicate; a list that drops one is refused | Accounting proves completeness, not that a finding is right. Free text (Codex's prose) is recorded but counts only with a structured transcription, which is the conductor's reading of it |
| Diagnostics do not leak what they record | Command output is redacted whole before it is cut; JSON artifacts and the run state are decoded and sanitized field by field, then written as valid JSON; a JSON artifact that does not parse is left out with the reason | Redaction catches the common shapes of secrets, not every one: review a bundle before sharing it |
| Every correction leaves a lesson | The retro is refused while a fixed finding or a round sent back is named by no lesson; each lesson names a check kind and what the check would be | Whether the lesson is the right one, and whether the check ever gets built, is not checked. The ledger shows when the same pattern comes back |
| GitHub steps act on this PR only | Every `gh` call names the run's repository; the PR's branch, base and head are checked against the run before CI is read and before the report is posted | PRs from forks are refused, not supported |
| Green CI means the required checks | Check runs and statuses are read for exactly the published commit, with where the required set came from. A requirement keeps the GitHub App the policy names: a same-name check from another producer, or a commit status, never stands in for it. The latest result per producer decides; skipped and neutral satisfy a requirement as on GitHub; an unknown state is never green. A 404 or 403 on the policy is `unknown`, never "nothing required"; the list you name is kept for that repository and base and matches any producer. A required check GitHub has not created yet is pending | The list you name is your word. Rulesets that cannot be read leave the policy unknown until you name the list. Merge-queue and merge-commit runs are not read; GitHub's own branch protection stays the merge boundary |
| No lost or crossed state | One lock around every write and around `init`, `end` and `recover`; atomic file replace for state and notes, last good copy kept (`loop.mjs recover`); a file that parses but is not a run or a list of notes is as unreadable as a cut-off one, and only a valid backup is restored | Local processes only; not a database |
| The board shows what the gate decided | The board asks the same function the gate uses, row by row: only checks accepted for the current request are counted, and "all passed" needs the gate's yes | The page is checked by hand in a browser, not by an automated UI test |
| Notes survive a change of session | A note handed to a session that never finished it is handed to the next owner once, under the same id; `loop.mjs inbox` lists everything not done | A note is "handed over" when a hook put it into the session's context; whether the agent acted on it is the `note done` record |
| One conductor at a time | A lease renewed by every hook call of the owning session, its workers' included; `acquire` takes over an expired one; after a takeover the old session's file edits are refused | Ownership is by Claude Code session id. One tool call longer than 15 minutes with nothing else running lets the lease expire. An old session's shell command that changes files is not caught |
| Not skip the browser check or the second review on its own | Skips need the human's word (`human:` reason) | That reason is the agent's word, not proof |
| Not rewrite the PR description to match what it built | Instructions | Instructions |
| Explanations on the board change nothing | `claude -p --tools Read,Grep,Glob --strict-mcp-config`, killed when you close it or after 3 minutes, two at a time | Hooks and settings of your Claude Code still apply to it. It needs the `claude` CLI signed in on its own (`claude auth login`): the desktop app's session does not carry over, and the board says so instead of answering |

## How it is built

| Part | File | Does |
| --- | --- | --- |
| Stage graph | `skills/story-loop/scripts/graph.json`, `loop.mjs` | the only moves that exist, the evidence each pass needs; state in `.start-story/active.json` |
| Stop gate | `scripts/hook.mjs` (Stop) | the session cannot end while a stage is pending; after four tries it records the stage as blocked |
| Guard and ownership | `scripts/hook.mjs` (PreToolUse) | see *What it will not do* |
| Publisher | `scripts/publish.mjs` | the only push of a run |
| GitHub steps | `scripts/github.mjs` | Copilot request and bounded wait, comments, required CI, the report comment — each recorded so a retry reconciles |
| Quality gate | `scripts/quality.mjs` | runs the lint commands it is given and reads the diff's added lines for slop signals; lane budgets are in `graph.json` |
| Ledger | `scripts/ledger.mjs`, `.git/story-loop/ledger.jsonl` | one line per run (a follow-up after the retro writes a newer one, which replaces it), written at the retro, at the human review and at `end`; `loop.mjs ledger` reads it |
| Mutants | `scripts/mutate.mjs` | breaks changed lines one at a time in a throwaway worktree; nothing to install (uses the project's `typescript` when it has one) |
| Test-result adapters | `scripts/adapters.mjs`, `scripts/reporters/node-json.mjs` | read node:test, Jest, Vitest and RSpec reports so a failure is attributed to the mutant or to the harness |
| Evals | `evals/run.mjs` | Layer A controller invariants, Layer B evaluator evals, Layer C live trials |
| Notes | `.start-story/<story>/inbox.json`, `scripts/hook.mjs` | carries what you write on the board to the agent |
| Setup check | `scripts/doctor.mjs` | prerequisites and their fixes |
| Diagnostics | `scripts/diag.mjs` | opt-in record of a run and its export; decides nothing |
| Board | `board/server.mjs`, `board/index.html` | one local page, no build step, no external requests |
| Conductor | `skills/story-loop/SKILL.md`, `stages/*.md` | the instructions the agent follows |
| Workers | `agents/worker-*.md` | four agents with fixed models |
| Advisor | `agents/advisor-fable.md` | read-only Fable for the contract, triage, the retro and the fallback review |

Everything is plain Node with no dependencies. The build stage is adapted
from [savvy-flow](https://github.com/johnnyvizz/claude-kit) (MIT).

## When something is off

| You see | Do |
| --- | --- |
| The agent stopped and the board says *needs you* | Read the banner: a sign-off, a parked finding or a missing prerequisite |
| A stage says *blocked* | The reason is next to it; fix it and tell the agent to continue |
| `the run state ... is unreadable` | `node <plugin>/skills/story-loop/scripts/loop.mjs recover` restores the last good copy; pushes and PR changes wait until then |
| `run ... belongs to session ...` | Another session owns the run; `loop.mjs acquire` in the new one (after 15 quiet minutes, or `--takeover "<why>"`) |
| A run from 0.6 | It migrates on first use and keeps its data; stages it already passed carry no code tree, so they count as stale and the run goes back to build for fresh evidence |
| A run started on 0.7 | Finish it on 0.7 or end it: browser results now need a request id (`loop.mjs start verify` again), the review is recorded with `loop.mjs review`, and mutation results need a fresh `mutate.mjs` run |
| `the notes file ... is unreadable` | `loop.mjs recover` restores the last good copy and keeps the broken file next to it; a note typed after that copy is only in the broken file |
| `required CI ... unknown` | The base branch's required checks could not be read (no permission, or GitHub answered 404); tell the agent which checks are required. Ask again after changing the base |
| A run started on 0.8 | End it and start again on 0.9: verify now needs a recorded environment and results with their URL, the review needs `start second_review` and `--request`, and the publisher needs the base recorded first |
| A run started before 0.21 | It migrates on first use (schema 4) and keeps its history, but nothing is invented for it: quality results, mutants, review requests and walkthroughs without a merge base, and free-text reviews without a transcription, show as not current. Run those again (`quality.mjs`, `mutate.mjs` with an `--adapter`, `loop.mjs start second_review`, `loop.mjs walkthrough`) |
| `NOT CURRENT: <gate>: <why>` | A gate that passed earlier no longer holds for the code now; the reason says which check to run again. Publication and `github.mjs ready` refuse until it holds |
| `say how to read this test command's results: --adapter` | Make the test command write its JSON report to `$STORY_LOOP_REPORT` (see SKILL.md, test_review), or pass `--adapter exit` knowingly |
| A run started on 0.9 | It migrates on first use: the three new stages are pending, so it stops at the quality gate before going on, and the contract needs a lane before it can pass again (`loop.mjs put lane …`) |
| `N slop signals need a decision` | Remove each one at its cause and run `quality.mjs` again, or record why it stands: `loop.mjs quality accept <id> "<reason>"` |
| `PR ... was open when the comments were last fetched` | The human review round ends at merge or close; merge it (or tell the agent you take the review from here), then run `/story-loop review <story>` again |
| `N corrections have no lesson` | The retro names a lesson for every fixed finding and every round sent back; `loop.mjs put lessons '[…]'` |
| `the push URL ... is not a GitHub repository story-loop can identify` | The remote uses an SSH host alias, another host, or a fork; point `origin`'s push URL at `git@github.com:<owner>/<name>` of the run's repository |
| `this ... finished for ... but ...; its result changes nothing here` (exit 4) | A helper outlived its run or its attempt; its result is in `.start-story/<story>/stale/`. Nothing to fix: run the step again for the current attempt |
| `record where the browser will test` | Start the app from the checkout and record it: `loop.mjs put environment '{"url":"http://127.0.0.1:3000","kind":"local"}'` |
| The board is empty | No run yet in that repo; it fills once the story starts |
| Worker cards show only the conductor | Your Claude Code version does not pass worker ids to hooks; the run is unaffected |
| You want to stop a run for good | `node <plugin>/skills/story-loop/scripts/loop.mjs end` in the repo; the run's record stays in `.start-story/<story>/` |

## Tests and evals

```bash
node --test tests/*.test.mjs                 # regression suite
node evals/run.mjs controller                # Layer A: seeded controller invariants (fixtures)
node evals/run.mjs graders                   # Layer B: the evaluators against known-good and faulty variants
node evals/run.mjs live --trials 3           # Layer C: real story-loop runs (see below); NOT RUN without its prerequisites
```

The suite and layers A and B are fixture runs: real git, bare repositories on
disk standing in for GitHub, a fake `gh`, a fake `claude`, real `node --test`
projects for the mutation runner. They do not start Claude Code, a browser or
anything on github.com, and none of their passes says how reliably an agent
completes a story.

- **Layer A** generates lifecycle sequences from seeds (replacement runs
  started, finished out of order or crashed; commits, message-only amends and
  base retargets; a torn state file; publications and their retries) and checks
  the gate decision, the publisher and the remote against a small reference
  model that uses plain git and no story-loop code. A failing seed is written to
  `evals/out/` with a minimized trace and the command that replays it.
- **Layer B** runs every evaluator on variants whose truth is known: app cases
  (authorization, persistence after "saved", a feature flag, empty/loading/error
  states, a login wall mistaken for the target page) graded by hidden graders on
  the resulting state, and story-loop's own evaluators (mutation attribution,
  CI producer identity, review accounting, diagnostic canaries). A case gates
  only after its known-good variants pass; it reports false acceptance, false
  rejection and detection per category.
- **Layer C** runs `/story-loop` itself, three to five times per case, on six
  representative stories (`evals/live/cases.json`) in a disposable GitHub
  repository, and grades the story branch with the Layer B graders. It needs
  `STORY_LOOP_LIVE=1`, `STORY_LOOP_LIVE_REPO` and the same name again in
  `STORY_LOOP_LIVE_REPO_CONFIRM`, `STORY_LOOP_LIVE_BUDGET_USD`, and the `claude`
  and `gh` CLIs signed in; without them it prints what is missing and runs
  nothing. Every trial is kept, failures included.

Three tests need a `typescript` 5.x package (the compiler-present branch of the
mutation runner; TypeScript 7 has no `transpileModule`). story-loop has no
dependencies, so without one they are reported as **skipped**, not passed. To
run them, point at any `node_modules` that has it; with
`STORY_LOOP_REQUIRE_TYPESCRIPT=1` (the release workflow,
`.github/workflows/story-loop.yml`) a missing compiler fails them instead:

```bash
STORY_LOOP_TEST_NODE_MODULES=/path/to/some/project/node_modules STORY_LOOP_REQUIRE_TYPESCRIPT=1 node --test tests/*.test.mjs
```
