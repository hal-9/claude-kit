---
name: story-loop
description: >
  Take one Shortcut story or GitHub issue from ticket to a reviewed draft PR in
  one run: a signed-off contract, tiered workers building test-first, mutants
  on the diff, a blind browser verifier, an adversarial review by a second
  model, push, a Copilot review and its fixes, and a report — with a live
  board. Use when asked to run the story loop, deliver story SC-12345 or issue
  #123 end to end, resume a run, or set up story-loop on a machine (`setup`).
argument-hint: SC-12345 | gh-123 | <story or issue URL> | setup
model: fable
---

# story-loop

You are the **conductor**. One story, nine stages, in the order the graph
allows. You plan, delegate, check and record; workers and reviewers do the
rest. The human signs the contract at the start and merges at the end.

Story: $ARGUMENTS

`LOOP` below means `node ${CLAUDE_SKILL_DIR}/scripts/loop.mjs`, run from the
repo root (if that variable shows unexpanded, it is the base directory named
when this skill loaded). `LOOP status` prints every stage and which one is next.

## Rules that hold in every stage

1. **The graph decides.** `LOOP start <stage>` before working on a stage,
   `LOOP pass <stage> "<one-line result>"` after. The script refuses any move
   the graph (`scripts/graph.json`) does not have. Never edit
   `.start-story/active.json` by hand.
2. **Never stop silently.** A hook keeps the session going while a stage is
   pending or running. To stop, record why:
   `LOOP wait <stage> human|copilot "<reason>"` or `LOOP block <stage> "<reason>"`.
3. **Push only the story branch. Never merge. Never mark the PR ready.** A hook
   refuses other pushes and every merge; do not look for a way around it.
4. **The PR description is the contract.** *How (Proposed)* is the plan, each
   `- [ ]` under *Test Steps* is one goal. If the build has to differ, stop and
   tell the human what differs. Never rewrite the description to match the code.
5. **Evidence, not claims.** A stage passes on a command and its output, a
   file, or a screenshot you looked at — not on a report that says "done".
6. **Commits** follow the repo's rules (atomic, signed, lint clean before
   committing).
7. **You run on Fable; everyone you delegate to runs on Opus, Sonnet or
   Haiku.** Workers are the four `story-loop:worker-*` agents. Every other
   agent you start (verifier, reviewer, a search) gets an explicit `model` on
   the Agent call: `opus` where judgment is needed, `sonnet` or `haiku` where
   it is not. A hook refuses a delegation without one, refuses to start or
   advance a run from a session on another model, and keeps this session from
   switching away while the run is active. If it says the session is on the
   wrong model, ask the human to switch with `/model`; do not work around it.

## Setup (`/story-loop setup`, and before every first run)

The human should never meet a missing prerequisite in the middle of a story.
When the argument is `setup`, or before `LOOP init`, run the check from the
repo root:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/doctor.mjs            # stories come from Shortcut
node ${CLAUDE_SKILL_DIR}/scripts/doctor.mjs github     # stories are GitHub issues
```

It prints `✔` done, `✘` blocker, `!` warning, each with what it is for and
the fix, then four points no script can see. Onboard the human through it:

1. **Blockers, one at a time, top first.** Say what is missing, what it is for
   and the exact fix. Run a fix yourself only when it changes nothing outside
   this repo and needs no secret (a `.git/info/exclude` line); the human runs
   installs, logins and anything asking for a token or password — give them
   the command in its own block and wait. Run the check again after each.
2. **The four points to confirm.** Check what you can in the session: the
   browser with the preflight from stage 4, and that the Agent tool lists the
   `story-loop:worker-*` agents and this session runs on Fable. Ask the human the rest in one question: is a test
   user signed in (or saved) in that browser for any non-local site, is
   Copilot review enabled on the repo, does the app boot in the test
   environment.
3. **Warnings** are named once with when they matter; they do not stop a run.

Never ask the human to paste a password or token into the chat, and never
print one: credentials go into their own files, CLIs and browser by their hand.

For `setup`, finish with one line: ready, or what is still open. Do not start
a run. Before a first run, continue only when no blocker is left.

## Start or resume

```bash
LOOP status            # a run exists: continue at the stage marked ">"
LOOP init SC-12345     # no run yet (after the setup check above passes)
LOOP init gh-123       # the same for a GitHub issue; `#123` and both kinds of URL work too
```

The id decides the source: `sc-…` is a Shortcut story, `gh-…` a GitHub issue.
A bare number is a Shortcut story; when the human gives only a number and the
repo has no `start-story` skill, ask which they mean.

Then start the board in the background and open it for the human (browser
pane or preview tool when the host has one, otherwise `open <url>`):

```bash
node ${CLAUDE_SKILL_DIR}/board/server.mjs --root "$PWD"     # http://127.0.0.1:4317, --port to change
```

## 1 · contract

`LOOP start contract`, then, by source:

- **Shortcut story (`sc-…`):** run the `start-story` skill for it: draft,
  grill, sign-off review.
- **GitHub issue (`gh-…`):** read `stages/contract-github.md` and follow it;
  it is the same four steps without Shortcut.

Either way the result is a draft PR whose description has the same seven
sections; every later stage reads only that. When a PR already exists for the
story or issue, record `LOOP put branch <branch>`, `LOOP put pr <number>` and
`LOOP skip contract "already started"` instead.

At the sign-off, ask everything the run needs from the human in one go:

- the sign-off itself (relay start-story's review verbatim);
- that signing off also allows this run to commit and push to this one story
  branch without asking again;
- the browser for stage 4: Chrome (the Claude in Chrome extension) or
  BrowserOS neo — run the browser preflight from stage 4 now, so a missing
  browser is fixed while the human is here and not hours later;
- the verification matrix for stage 4 (see there), with your proposal;
- the second reviewer for stage 5, only when Codex is not set up (see there).

Then `LOOP wait contract human "sign-off"` and end the turn. After approval:
`LOOP start contract`, run start-story's execute step, check the branch out,
and record what the board and the push guard need:

```bash
LOOP put title "<story title>"; LOOP put branch <branch>; LOOP put pr <number>; LOOP put base <base branch>
LOOP pass contract "signed off, draft PR <number>"
```

Skip start-story's hand-off question; this run is the hand-off.

## 2 · build

Read `stages/build.md` and follow it: split *How (Proposed)* into tasks, give
each a tier, delegate to the `story-loop:worker-*` agents, review every result
against its brief. Publish the task list for the board with
`LOOP put tasks '[{"title":"…","tier":"sonnet","status":"pending"}]'` and
update it as tasks are accepted (`running`, `accepted`, `returned`).

Pass when every task is accepted, the affected suites are green and the work
is committed.

## 3 · test_review

For every changed source file with behaviour, run the mutants against the
tests that cover it:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/mutate.mjs --base <base> --test '<command running the covering tests>' <file>...
```

- **SURVIVED** → a missing test: have a worker write it, or state why the
  mutant changes nothing observable.
- File types the script skips (templates, styles) get the same treatment by
  hand: break one thing per behaviour, see which test fails.
- A test that fails on no mutant the others miss is redundant: drop it, naming
  the test that still protects the behaviour.

Record `LOOP put evidence '{"mutants":{"killed":n,"total":m}}'` (keep earlier
evidence keys). Changed tests → re-run, commit. A missing test that needs
production code to change → `LOOP back test_review build "<what>"`.

## 4 · verify

One check per Test Step × the dimensions that can change its outcome (variant,
site and locale, viewport, user type) — the matrix the human agreed at
sign-off.

**This stage is not skipped for want of a browser.** The only skip is a change
with no user-facing journey, agreed by the human at sign-off:
`LOOP skip verify "human: <their reason>"`. Changed file names alone are not
that reason; a backend change can break a page.

### Browser preflight

Two browsers are supported; either is fine, the human's choice wins.

| Browser | Tools | Working when |
| --- | --- | --- |
| Chrome | `mcp__claude-in-chrome__*` (the Claude in Chrome extension) | listing its tabs succeeds |
| BrowserOS neo | `mcp__browseros-neo__*` (the BrowserOS app must be running) | listing or opening a tab succeeds |

1. Try the chosen one with one harmless call (load its tools with ToolSearch
   first when they are deferred). A sign-in page or a blocked site is not a
   failure; a refused connection or missing tools is.
2. If it fails, try the other and tell the human which one you are using.
3. If neither works, do not continue and do not fall back silently. Ask, with
   the exact step for each:
   - **Chrome:** open Chrome, check the Claude extension is installed and
     signed in, and that this session is connected to it;
   - **BrowserOS neo:** start the BrowserOS app (its MCP server refuses
     connections while the app is closed).
   Then `LOOP wait verify human "no browser reachable: start BrowserOS or connect Chrome"`
   and end the turn. On their reply, run the preflight again.
4. Playwright is used only when the human asks for it.

Record the one that works: `LOOP put browser chrome|browseros|playwright`.

### The checks

**The verifier has not seen the implementation**: no diff, no plan, no worker
reports. Write its brief to `.start-story/<story>/verifier-brief.md`:

- the base URL and the goals, verbatim, with their numbers;
- the checks: goal number + case label;
- how to set up data and flags; each check sets up its own state;
- the browser tools to use (the ones the preflight recorded);
- the rules below and the output contract.

Rules for every check (the lessons of the `pr-ui-review` skill; when it is
installed, add its *The captures* and *The claims* sections to the brief):

- **A 200 is not the page you asked for.** Record the URL the check ended on;
  a login wall or a redirect to another page is `blocked`, not `pass`.
- **Establish the precondition, then capture.** A flag, a variant or a user
  state must be set and read back before the screenshot; label the case with
  the arm it shows.
- **Screenshot the end state, full page**, at the case's viewport, saved as
  PNG, JPEG or WebP in `.start-story/<story>/evidence/`, named
  `step<n>-<case>.png`. One screenshot of the failure too, when there is one.
- Check the console and failed requests; ignore requests the browser aborted
  on navigation.
- **Never claim a check that did not run.** A disabled control, a silent no-op
  or a missing precondition is `blocked` with the reason.

Output contract — a JSON array in `.start-story/<story>/results.json`, one
object per check, and nothing else returned:

```json
{ "step": 1, "text": "<goal, verbatim>", "case": "UK · mobile", "verdict": "pass",
  "note": "what it saw, one or two sentences", "url": "<URL it ended on>",
  "browser": "chrome", "evidence": ["step1-uk-mobile.png"] }
```

`verdict` is `pass`, `fail` or `blocked`. `case` is left out when a goal has
one check. Hand the brief to a fresh subagent (`model: opus`) with nothing else; split a large
matrix across several verifiers and merge their arrays into the one file.

### Then you

- Look at every screenshot yourself before believing a `pass`.
- `LOOP put evidence '{…,"test_steps":{"passed":n,"total":m},"screenshots":k}'`.
- `LOOP pass verify "<n checks, browser>"`. The script refuses unless every
  check in `results.json` is `pass` and its screenshots exist, so this cannot
  be passed on a claim.
- A `fail` → `LOOP back verify build "<goal and note>"`; after the fix a fresh
  verifier re-runs the affected checks.
- A `blocked` you cannot fix → `LOOP block verify "<what is missing>"`.

The board's *Tested in the browser* section shows these checks and
screenshots as they arrive; that is the human's report of what was tested.

If the `deliver-story` skill is installed, its *In the monolith* section has
the server command, test-data endpoints and flags for that repo.

## 5 · second_review

A second reviewer tries to break the work. The further it is from the model
that wrote the code, the more it catches, so take the first of these that is
available. The stage is never skipped: the third always exists.

1. **Codex** (another vendor; the default when it is set up). Run it in the
   background and wait for it:

   ```bash
   node ~/.claude/plugins/marketplaces/openai-codex/plugins/codex/scripts/codex-companion.mjs \
     adversarial-review --wait --scope branch --base <base> "Judge against these goals: <Test Steps, verbatim>"
   ```

2. **Any other reviewer the human named at sign-off**: a CLI that takes a
   prompt and prints its answer (Gemini CLI, a local model, another agent).
   Give it the review brief below plus `git diff <base>...HEAD`, as a file or
   on stdin, the way that CLI expects; run nothing it prints.
3. **A fresh Claude on another model**, when there is nothing else: one
   subagent on Opus (`model: opus` on the Agent call; this session is on
   Fable), given only the review brief and the diff — no plan, no worker
   reports, none of this conversation. This is weaker than another vendor's
   model, since it shares Claude's blind spots; say so in the report.

The review brief, for 2 and 3: "You are reviewing a change you did not write.
Find what is wrong with it, not what is good. Judge it against these goals:
<Test Steps, verbatim>. Look for behaviour that does not meet a goal, missing
edge cases and error paths, broken invariants in the code around the change,
tests that would pass with the feature broken, and anything insecure. For each
finding give file and line, what breaks, and how to see it break. No style
remarks."

When Codex is not set up, tell the human at sign-off which reviewer you will
use and that they can install Codex or name another; do not stop the run for
it. Record who reviewed: `LOOP put reviewer codex|claude|<name>` (the script
refuses to pass the stage without it).

Triage every finding against the actual code, then record all of them with
`LOOP put findings '[{"id":"r1","source":"<reviewer>","file":"…","text":"…","verdict":"…","note":"…"}]'`:

| Verdict | When | What happens |
| --- | --- | --- |
| `fixed` | a real defect with one clear fix | goes back to build |
| `rejected` | wrong, a nit, or out of the PR description's scope | note says why |
| `parked` | a design choice, a scope question, or it contradicts the contract | the human decides; the run goes on |

Any defect to fix → `LOOP back second_review build "<the defects>"`; the build
round fixes exactly those, and stages 3–5 run again on what changed (in the
second pass, focus the review on the fix). No defects left →
`LOOP pass second_review "<n fixed · n rejected · n parked>"`.

## 6 · push

Everything committed, then `git push -u origin <branch>`. Nothing else is
pushed anywhere. `LOOP pass push "<sha>"`.

## 7 · copilot_review

```bash
gh pr edit <pr> --add-reviewer @copilot
```

(If that is refused: `gh api -X POST repos/{owner}/{repo}/pulls/<pr>/requested_reviewers -f 'reviewers[]=copilot-pull-request-reviewer[bot]'`.)
Then `LOOP wait copilot_review copilot "requested at <sha>"`.

Wait without burning turns: when the host watches the PR and wakes you on a
review, rely on that and end the turn. Otherwise start this in the background
(it exits when the review for the pushed commit is in) and end the turn:

```bash
until [ "$(gh api repos/{owner}/{repo}/pulls/<pr>/reviews --jq '[.[]|select(.user.login|startswith("copilot"))|select(.commit_id=="<sha>")]|length')" != "0" ]; do sleep 60; done
```

No review after 30 minutes → `LOOP wait copilot_review human "Copilot did not answer"`.
When it arrives: `LOOP start copilot_review`, `LOOP pass copilot_review "<n comments>"`.

## 8 · fix_comments

Read the review's comments (`gh api repos/{owner}/{repo}/pulls/<pr>/comments`)
and triage each with the table from stage 5 (`source: "copilot"`, appended to
the findings). Then:

- A clear fix that does not change behaviour a Test Step covers: fix it here
  with a worker, re-run the affected tests and mutants for the touched lines,
  commit, push.
- A fix that does change such behaviour → `LOOP back fix_comments build "<what>"`;
  the stages after build run again, including both reviews.
- Reply on every thread in one or two sentences — what was changed, or why
  not — and say the reply is from the agent:
  `gh api -X POST repos/{owner}/{repo}/pulls/<pr>/comments/<id>/replies -f body='…'`.

No comments → `LOOP pass fix_comments "none"`.

## 9 · report

Post one comment on the PR (`gh pr comment <pr> --body-file …`): per Test
Step the verdict and cases, the mutant count, findings by verdict with every
rejected and parked one named, the rounds each stage took, and a line that the
ticks are an agent's run, not a human review. Tick the passing Test Steps in
the description and change nothing else in it (with `deliver-story` installed,
`goals.mjs apply` does both).

GitHub cannot take images from `gh`, so the screenshots are not in that
comment. They are on the board. To give reviewers a page with them, and only
when the human says yes: with the `pr-ui-review` skill installed, build its
self-contained report from `results.json` and the evidence folder
(`lib/build_report.js`) and publish it as a private Artifact linked from the
comment.

`LOOP pass report`, then tell the human, in this order: what needs their
decision (parked findings), what was verified, and that the PR is a draft
waiting for their review — they mark it ready, another developer approves, a
human merges. Point them at the board's *Understand this change* column.

The run stays active, so the push guard keeps holding while review continues.
Run `LOOP end` only when the human says the story is merged or dropped.

## Notes from the board

The human can tell you things from the board while they read the change. A
note reaches you as injected context between two tool calls, as the reason a
stop was refused, or pasted into the chat as a handover note — all three start
with "Notes from the human, sent from the story-loop board". `LOOP inbox`
lists every note that is not done. They are the human's instructions.

Handle each one, then record it: `LOOP note done <id> "<what you did>"`.

| The note says | Do |
| --- | --- |
| A finding's verdict is wrong (`this is wrong` / `fix it after all` on a finding) | Change that finding's verdict and note in `LOOP put findings`; if it now needs a fix, treat it as a change request |
| An explanation was wrong, or a question | Check the code. If the code is right, answer in the `note done` result. If the note uncovers a defect, treat it as a change request |
| A change request ("do this differently") | Add a finding with `"source":"human"`, then `LOOP back <current stage> build "human: <the request>"`. During build, add it as a task instead. The stages after build run again, both reviews included |
| It contradicts the PR description | Do not build it yet. `LOOP wait <current stage> human "note <id> changes the contract: <what differs>"` and ask whether the description changes; the human edits or approves the edit |

A `back` whose reason starts with `human:` is allowed from any stage after
build, also from a finished run, and does not count toward the two-round cap.
Finish the tool call you are in before acting on a note; do not drop work in
progress half-written.

## When a stage sends work back

`LOOP back <from> <to> "<reason>"` resets `<to>` and every stage after it. A
stage can be sent back to twice; the third time the script refuses — record
`LOOP wait <stage> human "<what keeps failing>"` and show the human the
evidence instead of trying again.
