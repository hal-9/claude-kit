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
   grilled; `LOOP wait build human` and ask.
3. Break the work into tasks, each with:
   - a self-contained brief: what, where, constraints, definition of done, how
     to verify, the Test Step(s) it serves;
   - the **test seam** where behaviour changes (request spec, component,
     model, Jest module), so the worker builds test-first there; mechanical
     tasks name none;
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

You, the conductor, run on Fable and keep the overview, the design and every
judgment. Workers never run on Fable: a hook refuses any delegation that is
not one of these four or does not name `opus`, `sonnet` or `haiku`.

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
- Do not implement in parallel with workers. While they run, prepare the next
  briefs or the review checklist.

## 4. Review every result

Treat a worker report as a claim to check.

1. Read the actual diff, not the report.
2. Against the brief: scope creep, missing parts, silent assumptions, design
   deviations, anything that departs from the PR description.
3. What a careful reviewer would catch: edge cases, error paths, broken
   invariants, regressions next door, missing verification.
4. Re-run the verification yourself when it is cheap or the report is vague.
5. **Accept**, or **return** to the same or a higher tier with a precise list
   of defects. Take over only for a one-line correction. Two return rounds per
   task, then `LOOP wait build human "<task and what keeps failing>"`.

## 5. Close the stage

Every task accepted → run the affected spec and Jest suites once; failures go
back to the tier that owns the code. Commit (atomic, signed, lint clean).
Then `LOOP pass build "<n tasks, suites run>"`.
