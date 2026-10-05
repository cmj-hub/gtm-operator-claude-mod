import { describe, expect, test } from 'claude-code/testing'

import { addSample, sparkline, trend } from '../hooks/history'
import { newestFirst, scorerCandidates } from '../hooks/locate'
import { PACKS, packForPath } from '../hooks/packs'
import { fixPrompt, normalize, scoreLabel } from '../hooks/score'
import { draftExcerpt, draftText, refusedPhrases, voiceHits } from '../hooks/voice'
import type { History } from '../types'
import { FIXTURES } from './fixtures'

describe('normalize', () => {
  for (const pack of PACKS) {
    test(`${pack.id}: the good sample passes and the bad one fails with fixes`, () => {
      const good = FIXTURES[`${pack.id}-good`]!
      const bad = FIXTURES[`${pack.id}-bad`]!
      const passed = normalize(pack.id, good.stdout, good.exitCode, 1)
      const failed = normalize(pack.id, bad.stdout, bad.exitCode, 1)
      expect(passed.status).toBe('pass')
      expect(failed.status).toBe('fail')
      expect(failed.reasons.length + failed.fixes.length).not.toBe(0)
    })
  }

  test('numbers come from total and max_total', () => {
    const psp = normalize('psp', FIXTURES['psp-bad']!.stdout, 1, 1)
    expect(psp.score).toBe(37)
    expect(psp.axes.length).toBe(5)
    expect(scoreLabel(psp)).toMatch(/^37\/100 · \d+ fixes$/)
  })

  test('problem objects keep their own fixes', () => {
    const geo = normalize('findability', FIXTURES['findability-bad']!.stdout, 1, 1)
    expect(geo.reasons[0]).toBe('channel_decision: too short to be a decision')
    expect(geo.fixes[0]).toMatch(/say why search is or is not a channel/)
    const offer = normalize('offer', FIXTURES['offer-bad']!.stdout, 1, 1)
    expect(offer.fixes[0]).toMatch(/Cut the ask to buy/)
  })

  test('output that is not JSON is unknown, with the reason', () => {
    const score = normalize('page', 'Traceback (most recent call last):', 1, 1)
    expect(score.status).toBe('unknown')
    expect(score.detail).toContain('exited 1')
  })

  test('the fix prompt lists the fixes after the command', () => {
    const letter = normalize('letter', FIXTURES['letter-bad']!.stdout, 1, 1)
    expect(fixPrompt('/cold-email:cold-email', letter)).toMatch(/^\/cold-email:cold-email Fix the draft[\s\S]*- quote at least 3 words/)
  })
})

describe('locate', () => {
  const bases = {
    home: '/home/op',
    root: '/work/acme',
    packsDir: '/src/gtm',
    cacheVersions: { 'prospect-list': ['/c/prospect-list/0.4.0'] },
  }

  test('packsDir first, then the plugin cache, then skill folders', () => {
    const list = PACKS.find(one => one.id === 'list')!
    const paths = scorerCandidates(list, bases)
    expect(paths[0]).toBe('/src/gtm/claude-prospect-list/skills/who-to-contact/scripts/score.py')
    expect(paths).toContain('/c/prospect-list/0.4.0/skills/who-to-contact/scripts/score.py')
    expect(paths).toContain('/home/op/.claude/skills/who-to-contact/scripts/score.py')
  })

  test('versions sort newest first', () => {
    expect(newestFirst(['0.6.0', '0.10.1', '0.7.0'])).toEqual(['0.10.1', '0.7.0', '0.6.0'])
  })

  test('a draft path maps to its pack', () => {
    expect(packForPath('gtm/letter.json')?.id).toBe('letter')
    expect(packForPath('drafts/2026-10-05-proof.md')?.id).toBe('posts')
    expect(packForPath('gtm/notes.txt')).toBeUndefined()
  })
})

describe('voice', () => {
  test('the detail excerpt labels each field of a JSON draft', () => {
    expect(draftExcerpt(JSON.stringify({ psp: { signal: 'Posted a role', vocabulary: ['pipeline gap', 'SDR ramp'] } })))
      .toBe('signal: Posted a role\nvocabulary: pipeline gap, SDR ramp')
    expect(draftExcerpt(JSON.stringify([{ title: 'VP Sales', score: 'call this week' }])))
      .toBe('title: VP Sales\nscore: call this week')
    expect(draftExcerpt('A plain post.')).toBe('A plain post.')
  })

  const soul = '## Who I am\nJay\n\n## Phrases I refuse\n- synergy\n- "circle back"\n\n## Stories\n- the Acme save\n'

  test('reads the refused phrases section only', () => {
    expect(refusedPhrases(soul)).toEqual(['synergy', 'circle back'])
  })

  test('finds whole phrases in JSON drafts, case-insensitive', () => {
    const text = draftText(JSON.stringify({ letter: 'Happy to Circle back on the synergy.' }))
    expect(voiceHits(text, ['synergy', 'circle back', 'leverage'])).toEqual(['synergy', 'circle back'])
    expect(voiceHits('synergyless', ['synergy'])).toEqual([])
  })
})

describe('history', () => {
  test('skips repeats, draws a sparkline, and reports the trend', () => {
    let history: History = {}
    history = addSample(history, 'psp', { at: 1, score: 37, status: 'fail', fixes: 2 })
    history = addSample(history, 'psp', { at: 2, score: 37, status: 'fail', fixes: 2 })
    history = addSample(history, 'psp', { at: 3, score: 100, status: 'pass', fixes: 0 })
    expect(history.psp?.length).toBe(2)
    expect(sparkline(history.psp ?? [])).toBe('▃█')
    expect(trend(history.psp ?? [])).toBe(63)
  })
})
