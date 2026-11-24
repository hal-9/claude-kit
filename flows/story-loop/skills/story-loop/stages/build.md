# Build stage

Adapted from savvy-flow (johnnyvizz/claude-kit, MIT). Same roles: you think, plan, decide and review; workers
execute. Never do a worker's job yourself, and never let a worker do yours.

The task is fixed: implement the draft PR on this branch. Plan = *How
(Proposed)*, definition of done = every Test Step. In a round that came back
from a later stage, the task is only the defects named in the `back` reason.

## 1. Plan

1. Read what the plan names: the files, CLAUDE.md / AGENTS.md, recent history
   of those files. Use an Explore subagent only for wide searches.
2. If the story touches visible UI, design decisions are yours, from the
   story's design links: write them into the brief as concrete specs
   (structure, states, which existing components to reuse). Workers never
   invent UI. No design link for a UI story is a gap start-story should have
   grilled; `LOOP wait build human` and ask. A check with a Figma frame
   (`design` in the check list): read it with the Figma MCP
   (`get_design_context`, `get_screenshot`) and put its sizes, spacing,
   colours and copy into the brief; verify fails the check on any deviation.
   Any task that touches HTML, CSS or client-side JS: run the
   `modern-web-guidance` skill once, before writing the briefs, and put the
   patterns it returns into them as concrete specs (the native element or API
   to use, the deprecated one to avoid). The hook refuses a worker brief that
   names front-end files until the skill has run in this story; only on the
   human's word that it cannot be used: `LOOP put web_guidance "human: <why>"`.
3. Break the work into tasks, each with:
   - a self-contained brief: what, where, constraints, definition of done, how
     to verify, the Test Step(s) it serves;
   - the **test seam** where behaviour changes (request spec, component,
     model, Jest module), so the worker builds test-first there; mechanical
     tasks name none;
   - **the pattern to copy**: the existing file that does this the way this
     codebase wants it done, and, where the neighbourhood has an old or
     deprecated way, the one not to copy. A worker repeats whatever it reads
     next to its change; choosing the example is your job, not its luck;
   - dependencies on other tasks;
   - a tier.
4. Publish the tasks (`LOOP put tasks …`) and go on; the human already signed
   the plan. Ask only if a reading of the plan would lead to materially
   different work.

## 2. Tier

Pick the cheapest tier that gets the task right the first time.

| Agent | Model | Use for |
| --- | --- | --- |
| `story-loop:worker-haiku` | Haiku | mechanical edits, renames, config, boilerplate, running suites and reporting |
| `story-loop:worker-sonnet` | Sonnet | standard feature work, known-cause fixes, a few files, clear requirements |
| `story-loop:worker-opus` | Opus, high effort | delicate or unfamiliar work: multi-file changes, invariants, many edge cases, messy code |
| `story-loop:worker-opus-max` | Opus, max effort | the hardest tasks: unclear root cause, subtle logic, a bug that survived a first attempt |

You, the conductor, run on Opus and keep the overview, the design and every
judgment; Fable is only the read-only advisor (`story-loop:advisor-fable`),
never a worker. A hook refuses any delegation that is not one of these four,
the advisor, or an agent that names `opus`, `sonnet` or `haiku`.

Unsure between two → the higher one; a task returned once goes up a tier.
Insight and thoroughness both needed → two tasks: `worker-opus-max`
investigates and writes a precise brief, `worker-opus` implements it. If the
Agent tool lists the workers without the `story-loop:` prefix, use those
names. If it lists none, `LOOP block build "story-loop workers not loaded; start a new session"`.

## 3. Delegate

- One Agent call per task, `subagent_type` = the tier agent, `description` =
  the task title verbatim (the board matches workers to tasks by it).
  Independent tasks in parallel in one message; dependent ones in order.
- The worker cannot see this conversation. The brief carries file paths,
  design specs, the constraints that matter, and the exact verification.
- **Red first.** Every behaviour change starts with a test that fails for the
  right reason; the worker shows the failing run, then the passing one.
- **Tests to the point.** The brief sizes tests by what the change decides
  (each branch, boundary or default), not by its methods or inputs. Put both
  questions into it: *for each decision, would a test fail if it broke?* (no
  → a test is missing) and *for each new test, what plausible change makes it
  fail, and does another test already catch that?* (no answer, or already
  caught → do not write it). Prove each behaviour once, at the lowest layer
  that can: the service or model spec owns the rule, the request or controller
  spec only its mapping to HTTP (status, message), the component test only
  what the user sees. Inputs that differ only in data → one parametrized test.
  Never trimmed: authorization, input validation, personal data, money, data
  integrity, and regression tests for a real bug (a review finding included).
  When the repo has a `writing-tests` skill, the brief names it. The worker's
  report names the behaviour each new test protects.
- Do not implement in parallel with workers. While they run, prepare the next
  briefs or the review checklist, then end your turn. Each worker's report
  arrives as a notification that wakes you; the stop gate lets you end the
  turn while workers it saw start, or the loop's own helpers, are still
  running. Never wait by polling files, sleeping or watching the checkout go
  quiet.
- **Parallel workers share this checkout, so they never share files.** Give
  each parallel task its own files; tasks that touch the same file, the same
  test database or the same fixtures run one after another. Workers do not
  commit — you commit accepted work, one task at a time, so nobody's
  half-done change ends up in another task's commit. Tests that need one test
  database (Rails request specs, migrations) run serially.

## 4. Review every result

Treat a worker report as a claim to check.

1. Read the actual diff, not the report.
2. Against the brief: scope creep, missing parts, silent assumptions, design
   deviations, anything that departs from the PR description.
3. What a careful reviewer would catch: edge cases, error paths, broken
   invariants, regressions next door, missing verification, and tests that
   repeat a behaviour another test (or another layer) already proves.
   And what the quality gate will flag next: a linter switched off in place,
   a skipped test, a comment that justifies a shortcut. Return those now; a
   workaround is fixed at its cause, not explained.
4. Re-run the verification yourself when it is cheap or the report is vague.
5. **Accept**, or **return** to the same or a higher tier with a precise list
   of defects. Count each return on the task (`"returns": 1` in
   `LOOP put tasks`, kept when it is accepted later): the ledger judges the
   tier table by it. Take over only for a one-line correction. Two return rounds per
   task, then `LOOP wait build human "<task and what keeps failing>"`.

## 5. Close the stage

Every task accepted (`LOOP put tasks` with `"status":"accepted"`, the
`"files"` its diff changed and the `"steps"` it serves) → run the
affected spec and Jest suites once; failures go back to the tier that owns the
code. Commit (atomic, signed, lint clean). Then
`LOOP pass build "<n tasks, suites run>"` — refused while a task is not
accepted or anything is uncommitted.
