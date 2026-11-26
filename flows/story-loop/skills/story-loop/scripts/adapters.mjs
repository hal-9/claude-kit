// Test-result adapters for mutate.mjs: what one test run says, read from the runner's own
// structured report instead of its exit code. A mutant counts as behaviourally killed only
// when the report attributes the failure to the code under test (see judge()).
//
// Each adapter reads the file the test command writes to $STORY_LOOP_REPORT:
//   node    node --test --test-reporter=$STORY_LOOP_NODE_REPORTER --test-reporter-destination=$STORY_LOOP_REPORT <files>
//   jest    npx jest --json --outputFile=$STORY_LOOP_REPORT <files>
//   vitest  npx vitest run --reporter=json --outputFile=$STORY_LOOP_REPORT <files>
//   rspec   bundle exec rspec --format json --out $STORY_LOOP_REPORT <files>
//   exit    no report: only the exit code. Never chosen silently; every failure is then
//           checked against the unmutated code before it counts (kill_kind "exit-code").
// A report that is missing or does not parse is "inconclusive", never a kill.
import { fileURLToPath } from 'node:url'

export const ADAPTERS = ['node', 'jest', 'vitest', 'rspec', 'exit']
export const NODE_REPORTER = fileURLToPath(new URL('./reporters/node-json.mjs', import.meta.url))

// The adapter a command names on its face, or null (the caller must then say --adapter).
export function detectAdapter(command) {
  const c = String(command)
  if (/\bnode\b[^|;&]*--test\b/.test(c) && c.includes('STORY_LOOP_REPORT')) return 'node'
  if (/\bjest\b/.test(c) && c.includes('STORY_LOOP_REPORT')) return 'jest'
  if (/\bvitest\b/.test(c) && c.includes('STORY_LOOP_REPORT')) return 'vitest'
  if (/\brspec\b/.test(c) && c.includes('STORY_LOOP_REPORT')) return 'rspec'
  return null
}

const INFRA = /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EADDRINUSE|EHOSTUNREACH)\b|could not connect to server|Connection refused|PG::ConnectionBad|Redis::CannotConnectError/i
const BUILD = /\bTS\d{4}\b|error TS\d+|SyntaxError|Cannot find module|Unexpected token/

// One normalized report: { tests, failures: [{ name, kind, message }] } with kind one of
//   assertion   an expectation in a test body failed
//   runtime     a test body threw (TypeError, a failed call): attributable once clean code passes
//   setup       a hook (before/beforeAll/before(:all)) failed
//   timeout     one test ran out of time
//   collection  a test file could not be loaded or nothing was collected
//   build       a compile or type error while loading
export function parseReport(adapter, text) {
  if (adapter === 'node') return parseNode(text)
  if (adapter === 'jest' || adapter === 'vitest') return parseJest(text)
  if (adapter === 'rspec') return parseRspec(text)
  throw new Error(`adapter ${adapter} has no report`)
}

function parseNode(text) {
  const rows = String(text).split('\n').filter(Boolean).map(line => JSON.parse(line))
  // A skipped or todo test did not run: it counts for nothing (a filter that matches nothing selects no tests).
  const tests = rows.filter(r => r.kind !== 'suite' && !r.skipped && !r.fileLevel)
  const failures = rows.filter(r => r.type === 'test:fail' && r.kind !== 'suite').map(r => {
    const message = String(r.message ?? '')
    const kind = r.failureType === 'hookFailed' || r.failureType === 'cancelledByParent' ? 'setup'
      : r.failureType === 'testTimeoutFailure' ? 'timeout'
      : r.assertion ? 'assertion'
      // A file that threw while loading is reported as one failed "test" named after the file, with no cause.
      : r.fileLevel ? (BUILD.test(message) ? 'build' : 'collection')
      : 'runtime'
    return { name: r.name, kind, message, code: r.code ?? null }
  })
  return { tests: tests.length, failures }
}

function parseJest(text) {
  const data = JSON.parse(text)
  if (!Array.isArray(data?.testResults)) throw new Error('no testResults')
  const failures = []
  let tests = 0
  for (const file of data.testResults) {
    const cases = Array.isArray(file.assertionResults) ? file.assertionResults : []
    tests += cases.length
    if (file.status === 'failed' && !cases.length) {
      const message = String(file.message ?? file.failureMessage ?? '')
      failures.push({ name: file.name, kind: BUILD.test(message) ? 'build' : 'collection', message })
    }
    for (const c of cases.filter(c => c.status === 'failed')) {
      const message = (c.failureMessages ?? []).join('\n')
      const assertion = (c.failureDetails ?? []).some(d => d?.matcherResult) || /expect\(|AssertionError|toBe|toEqual/.test(message)
      failures.push({ name: c.fullName ?? c.title, kind: assertion ? 'assertion' : /beforeAll|beforeEach|afterAll/.test(message) ? 'setup' : 'runtime', message })
    }
  }
  return { tests, failures }
}

function parseRspec(text) {
  const data = JSON.parse(text)
  if (!Array.isArray(data?.examples)) throw new Error('no examples')
  const failures = data.examples.filter(e => e.status === 'failed').map(e => {
    const cls = String(e.exception?.class ?? '')
    const message = String(e.exception?.message ?? '')
    const kind = /RSpec::Expectations::|RSpec::Mocks::MockExpectationError/.test(cls) ? 'assertion' : /before\(:all\)|before\(:context\)/.test(message) ? 'setup' : 'runtime'
    return { name: e.full_description, kind, message }
  })
  if ((data.summary?.errors_outside_of_examples_count ?? 0) > 0)
    failures.push({ name: 'outside of examples', kind: data.examples.length ? 'setup' : 'collection', message: String(data.messages ?? '') })
  return { tests: data.examples.length, failures }
}

// What one run of the test command says about a mutant, before any clean recheck:
//   { outcome, recheck, kill_kind, why }
// recheck: true means the outcome holds only if the unmutated code, run again in the same
// slot right after, passes (the failure is then the mutant's doing); otherwise it is infra.
export function judge(exec, adapter, report) {
  const { code, signal, timedOut, error } = exec
  if (error) return { outcome: 'infra', why: `the command could not run (${error.message ?? error})` }
  if (timedOut) return { outcome: 'timeout', why: 'the test run timed out' }
  if (code === 126 || code === 127) return { outcome: 'infra', why: 'the command itself could not run' }
  if (code === null || code > 128 || signal) return { outcome: 'inconclusive', why: `killed by a signal we did not send (${signal ?? code})` }
  if (adapter === 'exit') return code === 0 ? { outcome: 'survived' } : { outcome: 'killed', recheck: true, kill_kind: 'exit-code', why: 'nonzero exit; no structured report to attribute it' }
  if (!report) return { outcome: 'inconclusive', why: `no readable ${adapter} report was written to $STORY_LOOP_REPORT` }
  const { tests, failures } = report
  if (!tests && code === 0) return { outcome: 'no_tests', why: 'the run selected no tests' }
  if (code === 0) return failures.length ? { outcome: 'inconclusive', why: 'exit 0, but the report lists failures' } : { outcome: 'survived' }
  if (!failures.length) return { outcome: 'inconclusive', why: 'nonzero exit, but the report lists no failure' }
  if (failures.some(f => f.kind === 'build')) return { outcome: 'build', why: 'the mutant does not compile or type-check' }
  if (failures.some(f => f.kind === 'assertion')) return { outcome: 'killed', kill_kind: 'assertion' }
  if (failures.some(f => f.kind === 'collection') || !tests) return { outcome: 'collection', recheck: true, why: 'tests could not be collected' }
  // A runtime error, a failed hook or a per-test timeout: the mutant's doing only if clean code passes now.
  const kind = failures.some(f => f.kind === 'runtime') ? 'runtime' : failures.some(f => f.kind === 'setup') ? 'setup' : 'timeout'
  const suspicious = failures.some(f => INFRA.test(f.message) || INFRA.test(f.code ?? ''))
  return { outcome: 'killed', recheck: true, kill_kind: kind, why: suspicious ? 'the failure looks like a dependency outage' : `a ${kind} failure, not an assertion` }
}

// The final outcome once the clean recheck (if any) ran: healthy is whether unmutated code passed.
export function settle(judged, healthy) {
  if (!judged.recheck) return judged
  return healthy ? judged : { outcome: 'infra', why: `${judged.why ?? 'the failure'}; the unmutated code fails the same way now, so the failure is not the mutant's` }
}
