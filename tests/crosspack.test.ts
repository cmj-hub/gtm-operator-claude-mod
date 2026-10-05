import { describe, expect, test } from 'claude-code/testing'

import { allFindings, consistencyFindings, coverageFindings, hashOf, staleFindings } from '../hooks/drift'
import type { Snapshot } from '../hooks/drift'
import { coldEmailView, evpLadder, founderView, geoView, pricingView, prospectBoard } from '../hooks/views'
import { CONFIG, NOW, PANE_PROPS, ROOT, RUN, fake } from './fake'
import { FIXTURES } from './fixtures'

const draft = (value: unknown, mtimeMs = NOW) => ({ text: typeof value === 'string' ? value : JSON.stringify(value), mtimeMs })
const DAY = 86_400_000

describe('cross-pack checks', () => {
  test('a draft older than a PSP or EVP change is stale', () => {
    const snapshot: Snapshot = {
      config: {},
      drafts: { letter: draft({ letter: 'x' }, NOW), page: draft({ offer: 'x' }, NOW + DAY) },
      changedAt: { psp: NOW + 3 * 3_600_000, evp: 0 },
    }
    const found = staleFindings(snapshot)
    expect(found.map(one => one.id)).toEqual(['stale-letter'])
    expect(found[0]?.message).toBe('First touch was written before your PSP changed (3 h later).')
    expect(found[0]?.fix).toMatch(/^\/cold-email:cold-email Update the draft/)
  })

  test('the page should lead with the EVP and name every tier', () => {
    const found = consistencyFindings({
      config: { evp: { primary: 'For Series-B SaaS in a pipeline gap, we name the accounts to call this week.' } },
      drafts: {
        page: draft({ url: 'https://example.com', offer: 'A wellness newsletter about breathing.', action: 'Subscribe' }),
        price: draft({ price: 1200, value_metric: 'per seat', contrast_set: ['Starter', 'Growth', 'Scale'] }),
      },
      changedAt: {},
    })
    expect(found.map(one => one.id)).toEqual(['page-evp', 'page-tiers'])
    expect(found[1]?.message).toBe('Price tiers missing from the landing page: Starter, Growth, Scale.')
  })

  test('the letter should use the buyer\'s own words', () => {
    const config = { psp: { vocabulary: ['pipeline gap', 'board meeting'] } }
    const missing = consistencyFindings({ config, drafts: { letter: draft({ letter: 'We help teams grow.' }) }, changedAt: {} })
    const present = consistencyFindings({ config, drafts: { letter: draft({ letter: 'Saw the pipeline gap before your board meeting.' }) }, changedAt: {} })
    expect(missing.map(one => one.id)).toEqual(['vocabulary-letter'])
    expect(present).toEqual([])
  })

  test('roles in icp.role_targets that the list leaves out', () => {
    const found = coverageFindings({
      config: CONFIG,
      drafts: { list: draft([{ title: 'VP Sales at Acme', signal: 'x', score: 'call this week' }]) },
      changedAt: {},
    })
    expect(found[0]?.message).toBe('No prospect on the list for: CRO (from icp.role_targets).')
  })

  test('hashes are stable and order-sensitive', () => {
    expect(hashOf({ a: 1 })).toBe(hashOf({ a: 1 }))
    expect(hashOf({ a: 1 })).not.toBe(hashOf({ a: 2 }))
    expect(allFindings({ config: {}, drafts: {}, changedAt: {} })).toEqual([])
  })
})

describe('view models', () => {
  test('pricing: the waterfall totals and the decoy checks', () => {
    const view = pricingView(FIXTURES.waterfall?.stdout, FIXTURES['decoy-broken']?.stdout, draft({ value_metric: 'per seat', contrast_set: ['A', 'B'] }))
    expect(view.customers[0]).toMatchObject({ id: 'acme', list: 14400, pocket: 10368, leakPct: 28 })
    expect(view.byStep[0]?.name).toBe('ramp')
    expect(view.checks.some(check => !check.passed)).toBe(true)
    expect(view.valueMetric).toBe('per seat')
  })

  test('prospects: one column per slot', () => {
    const board = prospectBoard(draft([
      { title: 'Ops lead at Northwind', signal: 'Posted a role', score: 'call this week' },
      { title: 'CFO at Beta', signal: 'Raised', score: 'hold' },
      { title: 'Someone', signal: '' },
    ]))
    expect([board.call.length, board.hold.length, board.drop.length, board.unscored.length]).toEqual([1, 1, 0, 1])
  })

  test('cold email: lint scores, replies, rhythm and a missing dig', () => {
    const mail = coldEmailView({
      letter: draft({ public_signal: 'Acme posted a role.', subject: 'Pipeline gap?', letter: 'Acme posted a role. Want the page?' }),
      config: { infrastructure: { sending_domain: 'outreach.acme.com' }, operations: { rhythm: 'Mon, Wed, Fri' } },
      spam: FIXTURES['spam-letter']?.stdout,
      subject: FIXTURES['subject-t1']?.stdout,
      replies: FIXTURES.replies?.stdout,
      deliverability: { exitCode: 2, stdout: '', stderr: FIXTURES['deliverability-nodig']?.stderr ?? '' },
      now: Date.UTC(2026, 9, 5),
    })
    expect(mail).toMatchObject({ words: 7, spamScore: 100, subjectScore: 100, domain: 'outreach.acme.com' })
    expect(mail.replies['buy-signal']).toBe(1)
    expect(mail.rhythm.filter(day => day.isSendDay).map(day => day.day)).toEqual(['Mon', 'Wed', 'Fri'])
    expect(mail.rhythm.find(day => day.isToday)?.day).toBe('Mon')
    expect(mail.deliverability?.lines[0]).toContain('`dig` is required')
  })

  test('cold email: deliverability checks as the script prints them', () => {
    const stdout = JSON.stringify({ checks: [{ name: 'SPF', status: 'pass', detail: 'v=spf1' }, { name: 'DMARC', status: 'fail', detail: 'p=none' }] })
    const mail = coldEmailView({ letter: undefined, config: {}, deliverability: { exitCode: 1, stdout, stderr: '' }, now: NOW })
    expect(mail.deliverability?.lines).toEqual(['✓ SPF: v=spf1', '✗ DMARC: p=none'])
  })

  test('EVP: the chosen tier and its drafts on the ladder', () => {
    const ladder = evpLadder({ evp: { tier: 3, primary: 'For X in Y, we do Z without W.' }, evp_drafts: [{ tier: 2, evp: 'Problem line' }] })
    expect(ladder.rungs[2]).toMatchObject({ name: 'Solution-aware', isChosen: true, lines: ['For X in Y, we do Z without W.'] })
    expect(ladder.rungs[1]?.lines).toEqual(['Problem line'])
  })

  test('GEO: days to the kill date, citations and blocked crawlers', () => {
    const geo = geoView(draft({
      buyer_question: 'How do I know which buyer question is worth a page?',
      kill_date: '2026-10-15',
      indexability_pass: { status: 200, noindex: false, raw_html_has_answer: true, robots: { GPTBot: 'blocked', Bingbot: 'allowed' } },
      citation_record: { observations: [{ engine: 'ChatGPT', brand_status: 'neither', cited_urls: ['a', 'b'] }] },
    }), Date.UTC(2026, 9, 5))
    expect(geo).toMatchObject({ daysLeft: 10, blockedBots: ['GPTBot'], isIndexable: true })
    expect(geo?.engines).toEqual([{ engine: 'ChatGPT', status: 'neither', cited: 2 }])
  })

  test('founder brand: pillars from file names and a stalled rotation', () => {
    const view = founderView([
      { name: '2026-09-20-proof-the-save.md', mtimeMs: 0 },
      { name: '2026-09-25-person-why.md', mtimeMs: 0 },
    ], Date.UTC(2026, 9, 5))
    expect(view.daysSinceLast).toBe(10)
    expect(view.isLate).toBe(true)
    expect(view.pillars.find(one => one.pillar === 'proof')).toMatchObject({ count: 1, lastDaysAgo: 15 })
  })
})

test('the Health tab lists a draft gone stale after the PSP changed, with a fix', async ($, on) => {
  const project = fake(on, { files: { 'brand-config.json': JSON.stringify(CONFIG), 'gtm/letter.json': JSON.stringify({ letter: 'x' }) } })
  await $.command.run({ command: 'gtm-board', ...RUN })
  project.setNow(NOW + 7_200_000)
  project.write('brand-config.json', JSON.stringify({ ...CONFIG, psp: { ...CONFIG.psp, primary_pain: 'a sharper pain' } }))
  const ran = await $.command.run({ command: 'gtm-health', ...RUN })
  expect(ran.text).toContain('[stale] First touch was written before your PSP changed')

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'gtm-operator', surface, component: 'Pane', requestId: 'gtm-board', props: PANE_PROPS })
    expect(await pane.find({ type: 'Text', text: /^Stale: First touch was written before your PSP changed/ })).toBeDefined()
    await pane.press({ key: 'finding-stale-letter' })
    expect(project.fills.at(-1)).toMatch(/^\/cold-email:cold-email Update the draft to match the current PSP/)
    await pane.unmount()
  }
})

test('the pricing and cold-email views run the packs\' own tools', async ($, on) => {
  const project = fake(on, {
    files: {
      'brand-config.json': JSON.stringify({ ...CONFIG, infrastructure: { sending_domain: 'outreach.acme.com' } }),
      'gtm/price.json': JSON.stringify({ price: 1200, value_metric: 'per seat', contrast_set: ['Starter', 'Growth', 'Scale'] }),
      'gtm/waterfall.csv': 'customer_id,list_price\nacme,1200\n',
      'gtm/tiers.json': JSON.stringify({ tiers: [] }),
      'gtm/letter.json': JSON.stringify({ public_signal: 'Acme posted a role.', letter: 'Acme posted a role. Want the page?' }),
    },
  })
  await $.command.run({ command: 'gtm-board', ...RUN })
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'gtm-operator', surface, component: 'Pane', requestId: 'gtm-board', props: PANE_PROPS })
    await pane.press({ key: 'tab-views' })
    await pane.press({ key: 'view-pricing' })
    expect(await pane.find({ type: 'Text', text: /^Pocket-price waterfall: \$\d/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^acme\s+█/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^Tier contrast check: 100\/100/ })).toBeDefined()

    await pane.press({ key: 'view-cold-email' })
    expect(await pane.find({ type: 'Text', text: 'Spam lint: 100/100 Ship' })).toBeDefined()
    await pane.press({ key: 'deliverability' })
    expect(await pane.find({ type: 'Text', text: /`dig` is required/ })).toBeDefined()
    await pane.unmount()
  }
  expect(project.runs.some(argv => argv.includes('outreach.acme.com'))).toBe(true)
})

test('views say what to run when there is no data yet', async ($, on) => {
  fake(on)
  await $.command.run({ command: 'gtm-board', ...RUN })
  const pane = await $.ui.mount({ plugin: 'gtm-operator', surface: 'terminal', component: 'Pane', requestId: 'gtm-board', props: PANE_PROPS })
  await pane.press({ key: 'tab-views' })
  for (const [key, text] of [
    ['view-prospects', 'No prospects yet. Run /prospect-list:who-to-contact.'],
    ['view-evp', 'No value line yet. Run /evp:evp.'],
    ['view-geo', 'No findability record yet. Run /geo:geo.'],
    ['view-founder', 'No posts in drafts/ yet. Run /founder-brand:founder-brand.'],
  ] as const) {
    await pane.press({ key })
    expect(await pane.find({ type: 'Text', text })).toBeDefined()
  }
})

test('Claude reads the cross-pack warnings', async ($, on) => {
  fake(on, { files: {
    'brand-config.json': JSON.stringify({ ...CONFIG, psp: { ...CONFIG.psp, vocabulary: ['pipeline gap'] } }),
    'gtm/letter.json': JSON.stringify({ letter: 'We help teams grow.' }),
  } })
  on('prompt.compose', () => ({ sections: [] }))
  await $.command.run({ command: 'gtm-board', ...RUN })
  const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [], sections: [] } as never)
  const text = composed.sections.find(one => one.id === 'gtm-operator:state')?.text ?? ''
  expect(text).toContain('Cross-pack warnings (heuristics; confirm before acting):')
  expect(text).toContain("First touch uses none of the buyer's words from your PSP")
  expect(ROOT).toBe('/work/acme')
})
