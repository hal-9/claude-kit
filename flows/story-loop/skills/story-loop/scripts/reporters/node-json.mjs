// A node:test reporter for story-loop's mutation runs: one JSON line per finished test,
// with what the adapter needs to attribute a failure (adapters.mjs, parseNode).
// Use: node --test --test-reporter=$STORY_LOOP_NODE_REPORTER --test-reporter-destination=$STORY_LOOP_REPORT
import { basename } from 'node:path'
export default async function* (source) {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue
    const d = event.data
    const error = d.details?.error
    const cause = error?.cause
    yield JSON.stringify({
      type: event.type, name: d.name, nesting: d.nesting, kind: d.details?.type ?? 'test', skipped: Boolean(d.skip || d.todo),
      failureType: error?.failureType ?? null,
      assertion: cause?.code === 'ERR_ASSERTION' || cause?.name === 'AssertionError',
      // node reports a file that failed to load, or that ran no test at all, as one top-level
      // "test" named after the file (on failure its cause is no Error). It is not a test.
      fileLevel: d.nesting === 0 && Boolean(d.file) && basename(String(d.file)) === basename(String(d.name)) && !(cause instanceof Error),
      code: cause?.code ?? null,
      message: String(cause?.message ?? cause ?? error?.message ?? '').slice(0, 500),
    }) + '\n'
  }
}
