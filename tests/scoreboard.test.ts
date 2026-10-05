import { expect, test } from 'claude-code/testing'

import { CONFIG, PANE_PROPS, ROOT, RUN, fake } from './fake'

const BAD_LETTER = JSON.stringify({ public_signal: 'BAD', letter: 'Hope you are well. BAD' })
const GOOD_LETTER = JSON.stringify({ public_signal: 'Acme posted a role.', letter: 'Acme posted a role. Want the page?' })

const SURFACES = ['terminal', 'desktop'] as const

test('the board shows each draft scored by its own pack', async ($, on) => {
  fake(on, {
    files: {
      'brand-config.json': JSON.stringify({ ...CONFIG, psp: { ...CONFIG.psp, primary_pain: 'BAD' } }),
      'gtm/letter.json': BAD_LETTER,
      'gtm/page.json': JSON.stringify({ url: 'https://example.com/desk' }),
    },
  })
  const ran = await $.command.run({ command: 'gtm-score', ...RUN })
  expect(ran.text).toMatch(/1\. Profile \(PSP\): 37\/100 · \d+ fixes/)
  expect(ran.text).toMatch(/4\. First touch: fail · 3 fixes — quote at least 3 words/)
  expect(ran.text).toContain('7. Landing page: pass')
  expect(ran.text).toContain('2. Value line (EVP): missing')

  await $.command.run({ command: 'gtm-board', ...RUN })
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ plugin: 'gtm-operator', surface, component: 'Pane', requestId: 'gtm-board', props: PANE_PROPS })
    expect(await pane.find({ key: 'step-psp', text: /✗ 1\. Profile \(PSP\)\s+37\/100 · \d+ fixes/ })).toBeDefined()
    expect(await pane.find({ key: 'step-page', text: /Landing page\s+pass/ })).toBeDefined()
    await pane.unmount()
  }
})

test('drill into a step and fix it with Claude', async ($, on) => {
  const project = fake(on, { files: { 'brand-config.json': JSON.stringify(CONFIG), 'gtm/letter.json': BAD_LETTER } })
  await $.command.run({ command: 'gtm-board', ...RUN })
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ plugin: 'gtm-operator', surface, component: 'Pane', requestId: 'gtm-board', props: PANE_PROPS })
    await pane.press({ key: 'step-letter' })
    expect(await pane.find({ type: 'Text', text: /4\. First touch\s+fail · 3 fixes/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /- quote at least 3 words of the signal/ })).toBeDefined()
    await pane.press({ key: 'fix' })
    expect(project.fills.at(-1)).toMatch(/^\/cold-email:cold-email Fix the draft so the scorer passes\.[\s\S]*- quote at least 3 words/)
    await pane.press({ key: 'tab-board' })
    await pane.unmount()
  }
})

test('a saved draft is scored at once and toasts the result', async ($, on) => {
  const project = fake(on)
  on('tool.call', (_$, e) => {
    if (e.tool === 'Write') project.write(e.file_path, e.content)
    return { result: { type: 'create' }, text: 'written' }
  })
  await $.command.run({ command: 'gtm-board', ...RUN })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/gtm/letter.json`, content: BAD_LETTER })
  expect(project.toasts.some(one => /^GTM First touch: fail · 3 fixes · quote at least 3 words/.test(one))).toBe(true)

  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/gtm/letter.json`, content: GOOD_LETTER })
  expect(project.toasts.at(-1)).toBe('GTM First touch: pass')
  expect(project.store.get(`history:${ROOT}`)).toMatchObject({ letter: [{ status: 'fail' }, { status: 'pass' }] })
})

test('the score gate refuses a draft below minScore and lets a passing one through', { options: { minScore: 70 } }, async ($, on) => {
  const project = fake(on)
  let writes = 0
  on('tool.call', (_$, e) => {
    writes += 1
    if (e.tool === 'Write') project.write(e.file_path, e.content)
    return { result: { type: 'create' }, text: 'written' }
  })
  const refused = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/gtm/letter.json`, content: BAD_LETTER })
  expect(refused.deny).toContain('below the minimum of 70')
  expect(refused.deny).toContain('- quote at least 3 words of the signal verbatim')
  expect(writes).toBe(0)

  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/gtm/letter.json`, content: GOOD_LETTER })
  expect(writes).toBe(1)
})

test('without the gate, a failing draft is written', async ($, on) => {
  const project = fake(on)
  let writes = 0
  on('tool.call', (_$, e) => {
    writes += 1
    if (e.tool === 'Write') project.write(e.file_path, e.content)
    return { result: { type: 'create' }, text: 'written' }
  })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/gtm/letter.json`, content: BAD_LETTER })
  expect(writes).toBe(1)
})

test('phrases refused in SOUL.md are flagged in any draft', async ($, on) => {
  fake(on, {
    files: {
      'brand-config.json': JSON.stringify(CONFIG),
      'SOUL.md': '## Phrases I refuse\n- synergy\n',
      'gtm/letter.json': JSON.stringify({ public_signal: 'Acme posted a role.', letter: 'Acme posted a role. Real synergy here.' }),
    },
  })
  await $.command.run({ command: 'gtm-board', ...RUN })
  const pane = await $.ui.mount({ plugin: 'gtm-operator', surface: 'terminal', component: 'Pane', requestId: 'gtm-board', props: PANE_PROPS })
  await pane.press({ key: 'step-letter' })
  expect(await pane.find({ type: 'Text', text: 'Refused phrases from SOUL.md: synergy' })).toBeDefined()
  expect(await pane.find({ key: 'fix' })).toBeDefined()
})

test('a pack that is not installed reads unknown, with how to install it', async ($, on) => {
  fake(on, { isInstalled: false, files: { 'brand-config.json': JSON.stringify(CONFIG), 'gtm/letter.json': GOOD_LETTER } })
  const ran = await $.command.run({ command: 'gtm-score', ...RUN, args: 'cold-email' })
  expect(ran.text).toContain('4. First touch: unknown')
  expect(ran.text).toContain('/plugin install cold-email@gtm-operator-skills')
})

test('packsDir is searched before the plugin cache', { options: { packsDir: '/src/gtm' } }, async ($, on) => {
  const project = fake(on, { isInstalled: false, files: {
    'brand-config.json': JSON.stringify(CONFIG),
    'gtm/letter.json': GOOD_LETTER,
    '/src/gtm/claude-cold-email/scripts/score_letter.py': '# scorer',
  } })
  await $.command.run({ command: 'gtm-score', ...RUN, args: 'cold-email' })
  expect(project.runs.at(-1)?.[1]).toBe('/src/gtm/claude-cold-email/scripts/score_letter.py')
})

test('with runScorers off, nothing runs', { options: { runScorers: false } }, async ($, on) => {
  const project = fake(on, { files: { 'brand-config.json': JSON.stringify(CONFIG), 'gtm/letter.json': BAD_LETTER } })
  const ran = await $.command.run({ command: 'gtm-score', ...RUN })
  expect(project.runs.length).toBe(0)
  expect(ran.text).toContain('runScorers is off')
})

test('Claude reads the failing drafts in its system prompt', async ($, on) => {
  fake(on, { files: { 'brand-config.json': JSON.stringify(CONFIG), 'gtm/letter.json': BAD_LETTER } })
  on('prompt.compose', () => ({ sections: [] }))
  await $.command.run({ command: 'gtm-board', ...RUN })
  const composed = await $.prompt.compose({ model: 'claude-test', promptModel: 'claude-test', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [], sections: [] } as never)
  const text = composed.sections.find(one => one.id === 'gtm-operator:state')?.text ?? ''
  expect(text).toContain("Drafts that fail their pack's scorer:")
  expect(text).toContain('- First touch (gtm/letter.json): fail · 3 fixes; first fix: quote at least 3 words')
})

test('a Markdown founder post is gated through --post', { options: { minScore: 70 } }, async ($, on) => {
  const project = fake(on)
  on('tool.call', () => ({ result: { type: 'create' }, text: 'written' }))
  const refused = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/drafts/2026-10-05-proof.md`, content: 'BAD post' })
  expect(refused.deny).toContain('Founder posts draft scores 37')
  expect(project.runs.at(-1)?.slice(2)).toEqual(['--post', 'BAD post', '--json'])
})
