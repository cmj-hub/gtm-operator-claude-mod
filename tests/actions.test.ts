import { describe, expect, test } from 'claude-code/testing'

import { addOutcome, digest, importOutcomes, outcomesByVersion, packStats, parseOutcomeCsv, sprintStep } from '../hooks/analytics'
import type { Scores } from '../types'
import { BAND_PROPS, CONFIG, NOW, PANE_PROPS, ROOT, RUN, fake } from './fake'

const BAD_LETTER = JSON.stringify({ public_signal: 'BAD', letter: 'BAD' })
const TURN = { turnId: 't1', answer: 'done', durationMs: 1000, isAborted: false, usage: null } as never
const DAY = 86_400_000

describe('analytics', () => {
  test('drafts to pass, time to pass and fixes resolved', () => {
    const stats = packStats('letter', [
      { at: NOW, status: 'fail', fixes: 3 },
      { at: NOW + 3_600_000, status: 'fail', fixes: 1 },
      { at: NOW + 7_200_000, status: 'pass', fixes: 0 },
    ])
    expect(stats).toMatchObject({ samples: 3, draftsToPass: 2, timeToPass: 7_200_000, fixesResolved: 3 })
  })

  test('outcomes are whole numbers, totalled per letter version', () => {
    expect(addOutcome([], { at: 1, kind: 'replies', count: 2.5, version: 'a' })).toBeUndefined()
    const log = addOutcome(addOutcome([], { at: 1, kind: 'replies', count: 4, version: 'a', score: 60 }) ?? [], { at: 2, kind: 'meetings', count: 1, version: 'a' }) ?? []
    expect(outcomesByVersion(log)).toEqual([{ version: 'a', replies: 4, meetings: 1, score: 60 }])
  })

  test('an outcome CSV: date plus replies and/or meetings, bad rows named', () => {
    const parsed = parseOutcomeCsv('Week,Replies,Meetings,Notes\n2026-09-28,4,1,"good, week"\n2026-10-05,2,,\nnot a date,3,0\n2026-10-06,two,0\n')
    expect(parsed.rows).toEqual([
      { at: Date.parse('2026-09-28'), kind: 'replies', count: 4 },
      { at: Date.parse('2026-09-28'), kind: 'meetings', count: 1 },
      { at: Date.parse('2026-10-05'), kind: 'replies', count: 2 },
      { at: Date.parse('2026-10-06'), kind: 'meetings', count: 0 },
    ])
    expect(parsed.errors).toEqual(['line 4: "not a date" is not a date', 'line 5: replies "two" is not a whole number'])
    expect(parseOutcomeCsv('day,calls\n2026-09-28,3\n').errors).toEqual(['no date column, or no replies or meetings column'])
  })

  test('importing again replaces that day, it does not add twice', () => {
    const rows = parseOutcomeCsv('date,replies\n2026-09-28,4\n').rows
    const once = importOutcomes([{ at: 1, kind: 'replies', count: 9, version: 'abc123' }], rows)
    const twice = importOutcomes(once, parseOutcomeCsv('date,replies\n2026-09-28,5\n').rows)
    expect(twice).toEqual([
      { at: 1, kind: 'replies', count: 9, version: 'abc123' },
      { at: Date.parse('2026-09-28'), kind: 'replies', count: 5, version: 'imported' },
    ])
  })

  test('the digest says what moved, what needs work, and what came back', () => {
    const scores: Scores = { letter: { pack: 'letter', status: 'fail', reasons: [], fixes: ['quote the signal'], axes: [], at: NOW } }
    const text = digest({
      now: NOW,
      history: { psp: [{ at: NOW - 10 * DAY, score: 37, status: 'fail', fixes: 2 }, { at: NOW - DAY, score: 100, status: 'pass', fixes: 0 }] },
      scores,
      findings: [{ id: 'x', kind: 'stale', packs: ['letter'], message: 'First touch is stale.' }],
      outcomes: [{ at: NOW - DAY, kind: 'replies', count: 3, version: 'a' }],
      nextCommand: '/evp:evp',
    })
    expect(text).toContain('# GTM weekly digest, 2026-09-28 to 2026-10-05')
    expect(text).toContain('- Profile (PSP): 37 → 100')
    expect(text).toContain('- First touch: fail · 1 fix. First fix: quote the signal')
    expect(text).toContain('- First touch is stale.')
    expect(text).toContain('- Replies: 3')
    expect(text.trimEnd().endsWith('Next: /evp:evp')).toBe(true)
  })

  test('the sprint advances on a pass, stops at the target, and pauses on a fail', () => {
    const pass: Scores = { evp: { pack: 'evp', status: 'pass', reasons: [], fixes: [], axes: [], at: 1 } }
    const fail: Scores = { evp: { pack: 'evp', status: 'fail', score: 59, reasons: [], fixes: ['x'], axes: [], at: 1 } }
    expect(sprintStep('evp', 10, pass)).toEqual({ kind: 'advance', next: 'list' })
    expect(sprintStep('evp', 2, pass)).toEqual({ kind: 'done' })
    expect(sprintStep('evp', 10, fail)).toEqual({ kind: 'pause', reason: 'Value line (EVP) fails its scorer (59/100 · 1 fix)' })
    expect(sprintStep('evp', 10, {})).toEqual({ kind: 'pause', reason: 'Value line (EVP) has no draft yet' })
  })
})

test('session start registers the commands, the tools Claude can call, and the reviewer', async ($, on) => {
  const project = fake(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT } as never)
  expect(project.registered.commands).toEqual(['gtm-board', 'gtm-score', 'gtm-health', 'gtm-guard', 'gtm-sprint', 'gtm-digest', 'gtm-outcomes'])
  expect(project.registered.tools).toEqual(['gtm_status', 'gtm_score', 'gtm_consistency'])
  const reviewer = project.registered.agents[0]
  expect(reviewer?.name).toBe('reviewer')
  expect(reviewer?.tools).toEqual(['Read', 'Glob', 'Grep', 'mcp__gtm-operator__gtm_score', 'mcp__gtm-operator__gtm_status', 'mcp__gtm-operator__gtm_consistency'])
  expect(reviewer?.prompt).toContain('You do not edit files.')
})

test('Claude can score a draft and read status and warnings through its tools', async ($, on) => {
  fake(on, { files: {
    'brand-config.json': JSON.stringify(CONFIG),
    'gtm/letter.json': BAD_LETTER,
    'gtm/list.json': JSON.stringify({ title: 'VP Sales at Acme', signal: 'Posted a role', score: 'call this week' }),
  } })
  const scored = await $.tool.call({ tool: 'mcp__gtm-operator__gtm_score', pack: 'cold-email' } as never)
  expect(String(scored.text)).toMatch(/^First touch \(\/cold-email:cold-email\): fail · 3 fixes/)
  expect(String(scored.text)).toContain('fix: quote at least 3 words of the signal verbatim in the first line')

  const status = await $.tool.call({ tool: 'mcp__gtm-operator__gtm_status' } as never)
  expect(String(status.text)).toContain('4. First touch (/cold-email:cold-email): fail · 3 fixes')

  const byFile = await $.tool.call({ tool: 'mcp__gtm-operator__gtm_score', file: 'gtm/letter.json' } as never)
  expect(String(byFile.text)).toMatch(/^First touch \(\/cold-email:cold-email\), gtm\/letter\.json: fail · 3 fixes/)
  const notDraft = await $.tool.call({ tool: 'mcp__gtm-operator__gtm_score', file: 'README.md' } as never)
  expect(String(notDraft.text)).toContain('README.md is not a GTM draft')

  const unknown = await $.tool.call({ tool: 'mcp__gtm-operator__gtm_score', pack: 'nope' } as never)
  expect(String(unknown.text)).toContain('Unknown pack "nope"')

  const consistency = await $.tool.call({ tool: 'mcp__gtm-operator__gtm_consistency' } as never)
  expect(String(consistency.text)).toContain('[coverage] No prospect on the list for: CRO')
})

test('Run on the band submits the next pack', async ($, on) => {
  const project = fake(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))
  await $.command.run({ command: 'gtm-board', ...RUN })
  const band = await $.ui.mount({ plugin: 'gtm-operator', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await band.press({ key: 'run' })
  expect(project.submits).toEqual(['/evp:evp'])
})

test('the sprint runs each pack only after the one before passes', async ($, on) => {
  const project = fake(on)
  const started = await $.command.run({ command: 'gtm-sprint', ...RUN, args: 'to 3' })
  expect(started.text).toMatch(/^Sprint started: \/evp:evp is in your prompt; send it to start/)
  expect(project.fills.at(-1)).toBe('/evp:evp')

  // The EVP turn writes a failing line: the sprint pauses and runs nothing.
  project.write('brand-config.json', JSON.stringify({ ...CONFIG, evp: { primary: 'BAD' } }))
  await $.turn.complete(TURN)
  expect(project.toasts.at(-1)).toMatch(/^GTM sprint paused: Value line \(EVP\) fails its scorer/)
  expect(project.submits).toEqual([])

  // Fixed: resume puts the next pack in the prompt.
  project.write('brand-config.json', JSON.stringify({ ...CONFIG, evp: { primary: 'For Series-B SaaS in a pipeline gap, we name the accounts.' } }))
  const resumed = await $.command.run({ command: 'gtm-sprint', ...RUN, args: 'resume' })
  expect(resumed.text).toBe('GTM sprint resumed: /prospect-list:who-to-contact is in your prompt; send it to go on.')
  expect(project.fills.at(-1)).toBe('/prospect-list:who-to-contact')

  // The list passes and step 3 is the target: done.
  project.write('gtm/list.json', JSON.stringify({ title: 'Ops lead', signal: 'Posted a role', score: 'call this week' }))
  await $.turn.complete(TURN)
  expect(project.toasts.at(-1)).toBe('GTM sprint done through step 3.')
})

test('in a -p run with no prompt to fill, /gtm-sprint names the command to run instead', async ($, on) => {
  const project = fake(on)
  await $.session.start({ surface: null, isInteractive: false, cwd: ROOT } as never)
  const started = await $.command.run({ command: 'gtm-sprint', ...RUN })
  expect(started.text).toMatch(/^Sprint started: run \/evp:evp to start, then each pack/)
  expect(project.fills).toEqual([])
})

test('after a passing turn the sprint runs the next pack itself; a subagent turn never moves it', async ($, on) => {
  const project = fake(on)
  await $.command.run({ command: 'gtm-sprint', ...RUN })
  project.write('brand-config.json', JSON.stringify({ ...CONFIG, evp: { primary: 'For Series-B SaaS in a pipeline gap, we name the accounts.' } }))
  await $.turn.complete({ ...(TURN as object), agentId: 'sub-1' } as never)
  expect(project.submits).toEqual([])
  await $.turn.complete(TURN)
  // The next pack runs from a timer once the turn is over; let it fire.
  await $.tool.call({ tool: 'mcp__gtm-operator__gtm_status' } as never)
  expect(project.submits).toEqual(['/prospect-list:who-to-contact'])
  expect(project.toasts.at(-1)).toBe('GTM sprint: Value line (EVP) passes. Next: /prospect-list:who-to-contact')
  const stopped = await $.command.run({ command: 'gtm-sprint', ...RUN, args: 'stop' })
  expect(stopped.text).toBe('GTM sprint stopped.')
})

test('analytics: log outcomes, see history, copy the digest', async ($, on) => {
  const project = fake(on, { files: { 'brand-config.json': JSON.stringify(CONFIG), 'gtm/letter.json': BAD_LETTER } })
  await $.command.run({ command: 'gtm-board', ...RUN })
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'gtm-operator', surface, component: 'Pane', requestId: 'gtm-board', props: PANE_PROPS })
    await pane.press({ key: 'tab-analytics' })
    expect(await pane.find({ type: 'Text', text: /^First touch\s+▁\s+fail|^First touch\s+\S*\s+1 run · not passing yet/ })).toBeDefined()
    await pane.input({ key: 'outcome-replies', text: '4' })
    expect(await pane.find({ type: 'Text', text: /^letter [0-9a-z]+: \d+ replies · 0 meetings/ })).toBeDefined()
    await pane.press({ key: 'digest' })
    expect(project.copies.at(-1)).toMatch(/^# GTM weekly digest/)
    await pane.unmount()
  }
  expect(project.store.get(`outcomes:${ROOT}`)).toMatchObject([{ kind: 'replies', count: 4 }, { kind: 'replies', count: 4 }])

  const ran = await $.command.run({ command: 'gtm-digest', ...RUN })
  expect(ran.text).toContain('## What needs work')
  expect(ran.text).toContain('- Replies: 8')
})

test('/gtm-outcomes import reads a CSV from the project into the outcome log', async ($, on) => {
  const project = fake(on, { files: {
    'brand-config.json': JSON.stringify(CONFIG),
    'crm/outcomes.csv': 'date,replies,meetings\n2026-10-01,6,2\n2026-10-02,x,1\n',
  } })
  const ran = await $.command.run({ command: 'gtm-outcomes', ...RUN, args: 'import crm/outcomes.csv' })
  expect(ran.text).toBe('Imported 3 outcome rows from crm/outcomes.csv. Skipped: line 3: replies "x" is not a whole number.')
  expect(project.store.get(`outcomes:${ROOT}`)).toMatchObject([
    { kind: 'replies', count: 6, version: 'imported' },
    { kind: 'meetings', count: 2, version: 'imported' },
    { kind: 'meetings', count: 1, version: 'imported' },
  ])
  const missing = await $.command.run({ command: 'gtm-outcomes', ...RUN, args: 'import nope.csv' })
  expect(missing.text).toBe('No file at nope.csv (paths are from the project root).')
  const outside = await $.command.run({ command: 'gtm-outcomes', ...RUN, args: 'import ../secrets.csv' })
  expect(outside.text).toBe('Give a path inside the project, like crm/outcomes.csv.')
  const listed = await $.command.run({ command: 'gtm-outcomes', ...RUN })
  expect(listed.text).toContain('imported: 6 replies · 3 meetings')
  await $.command.run({ command: 'gtm-board', ...RUN })
  const pane = await $.ui.mount({ plugin: 'gtm-operator', surface: 'terminal', component: 'Pane', requestId: 'gtm-board', props: PANE_PROPS })
  await pane.press({ key: 'tab-analytics' })
  expect(await pane.find({ type: 'Text', text: 'imported from CSV: 6 replies · 3 meetings' })).toBeDefined()
  await pane.unmount()
})
