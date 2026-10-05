import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const ROOT = '/work/acme'
const RUN = {
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const

const CONFIG = {
  operator: { name: 'Jay', company: 'Acme' },
  icp: { segment: 'Series-B SaaS, 50-200 people, US', role_targets: ['VP Sales', 'CRO'] },
  psp: { primary_pain: 'reps miss renewal signals', signal_anchors: ['new CRO hired'] },
}

// A project with setup and psp done, served beneath the plugin.
function project(on: On) {
  const files: Record<string, string> = { 'brand-config.json': JSON.stringify(CONFIG, null, 2) }
  const strip = (path: string) => path.replace(`${ROOT}/`, '')
  on('session.root', () => ({ value: ROOT }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.now', () => ({ value: Date.UTC(2026, 9, 5) }))
  on('fs.exists', (_$, e) => ({ value: strip(e.path) in files }))
  on('fs.read', (_$, e) => {
    const text = files[strip(e.path)]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.list', (_$, e) => (e.path === `${ROOT}/gtm` ? { value: [] } : { deny: 'ENOENT' }))
  return files
}

test('/gtm-board names the value line as the next step', async ($, on) => {
  project(on)
  const ran = await $.command.run({ command: 'gtm-board', ...RUN })
  expect(ran.text).toContain('Done: 0, 1')
  expect(ran.text).toContain('Next: /evp:evp')
})

test('a Write that drops a filled brand-config value is refused', async ($, on) => {
  project(on)
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
  project(on)
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
  const files = project(on)
  files['SOUL.md'] = '## Who I am\nJay\n\n## Phrases I refuse\n- synergy\n'
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
  project(on)
  let filled = ''
  on('prompt.fill', (_$, e) => {
    filled = e.text
    return { isFilled: true }
  })
  await $.command.run({ command: 'gtm-board', ...RUN })

  const site = { scroll: { offset: 0, bodyRows: 30 }, view: {} }
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({
      plugin: 'gtm-operator',
      surface,
      component: 'Pane',
      requestId: 'gtm-board',
      props: { title: 'GTM board', isFocused: false, bodyColumns: 60, placement: 'dock', ...site },
    })
    expect(await pane.find({ type: 'Text', text: /2\/11 steps in place/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /Next: \/evp:evp/ })).toBeDefined()
    await pane.press({ key: 'fill' })
    expect(filled).toBe('/evp:evp')

    const band = await $.ui.mount({
      plugin: 'gtm-operator',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100, ...site },
    })
    expect(await band.find({ type: 'Text', text: 'GTM 2/11' })).toBeDefined()
    await band.unmount()
    await pane.unmount()
  }
})
