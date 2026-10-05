import { expect, test } from 'claude-code/testing'

import { BAND_PROPS, CONFIG, PANE_PROPS, ROOT, RUN, fake } from './fake'

test('/gtm-board names the value line as the next step', async ($, on) => {
  fake(on)
  const ran = await $.command.run({ command: 'gtm-board', ...RUN })
  expect(ran.text).toContain('Done: 0, 1')
  expect(ran.text).toContain('Next: /evp:evp')
})

test('a Write that drops a filled brand-config value is refused', async ($, on) => {
  fake(on)
  on('tool.call', () => ({ result: { type: 'create' }, text: 'written' }))
  const ran = await $.tool.call({
    tool: 'Write',
    file_path: `${ROOT}/brand-config.json`,
    content: JSON.stringify({ operator: { name: 'Jay' }, evp: { primary: 'one line' } }),
  })
  expect(ran.deny).toContain('icp, psp')
  expect(ran.deny).toContain('operator.company')
})

test('a Write that only adds fields goes through', async ($, on) => {
  fake(on)
  let isWritten = false
  on('tool.call', () => {
    isWritten = true
    return { result: { type: 'update' }, text: 'written' }
  })
  await $.tool.call({
    tool: 'Write',
    file_path: `${ROOT}/brand-config.json`,
    content: JSON.stringify({ ...CONFIG, evp: { primary: 'Catch renewal risk the week it starts.' } }),
  })
  expect(isWritten).toBe(true)
})

test('an Edit that removes a SOUL.md section is refused, and /gtm-guard off lets it through', async ($, on) => {
  fake(on, {
    files: {
      'brand-config.json': JSON.stringify(CONFIG),
      'SOUL.md': '## Who I am\nJay\n\n## Phrases I refuse\n- synergy\n',
    },
  })
  let edits = 0
  on('tool.call', () => {
    edits += 1
    return { result: {}, text: 'edited' }
  })
  const edit = {
    tool: 'Edit' as const,
    file_path: `${ROOT}/SOUL.md`,
    old_string: '## Phrases I refuse\n- synergy\n',
    new_string: '',
  }
  const refused = await $.tool.call(edit)
  expect(refused.deny).toContain('## Phrases I refuse')
  expect(edits).toBe(0)

  await $.command.run({ command: 'gtm-guard', ...RUN, args: 'off' })
  await $.tool.call(edit)
  expect(edits).toBe(1)
})

test('the board pane and the band draw the next step on terminal and desktop', async ($, on) => {
  const project = fake(on)
  // Another mod's band row, which ours must keep
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by another mod'] }))
  await $.command.run({ command: 'gtm-board', ...RUN })

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({
      plugin: 'gtm-operator',
      surface,
      component: 'Pane',
      requestId: 'gtm-board',
      props: PANE_PROPS,
    })
    expect(await pane.find({ type: 'Text', text: /2\/11 steps in place/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /Next: \/evp:evp/ })).toBeDefined()
    await pane.press({ key: 'fill' })
    expect(project.fills.at(-1)).toBe('/evp:evp')

    const band = await $.ui.mount({
      plugin: 'gtm-operator',
      surface,
      component: 'AbovePrompt',
      props: BAND_PROPS,
    })
    expect(await band.find({ type: 'Text', text: 'GTM 2/11' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'drawn by another mod' })).toBeDefined()
    await band.unmount()
    await pane.unmount()
  }
})

test('after /clear the board and the hidden band come back from the files and the store', async ($, on) => {
  const project = fake(on)
  project.store.set('isBandHidden', true)
  on('classic.SessionStart', () => ({}))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))

  await $.classic.SessionStart({ source: 'clear' })

  const band = await $.ui.mount({
    plugin: 'gtm-operator',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: BAND_PROPS,
  })
  expect(await band.find({ type: 'Text', text: /GTM \d+\/11/ })).toBeUndefined()
  const pane = await $.ui.mount({
    plugin: 'gtm-operator',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'gtm-board',
    props: PANE_PROPS,
  })
  expect(await pane.find({ type: 'Text', text: /2\/11 steps in place/ })).toBeDefined()
})

test('a guard that fails refuses the write to brand-config.json', async ($, on) => {
  // The first root lookup fails inside the guard; the catch handler's succeeds
  fake(on, { failedRoots: 1 })
  let isWritten = false
  on('tool.call', () => {
    isWritten = true
    return { result: {}, text: 'written' }
  })
  const ran = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/brand-config.json`, content: '{}' })
  expect(ran.deny).toContain('the merge check on brand-config.json failed')
  expect(isWritten).toBe(false)
})
