// The suite's state, read the way /gtm:next reads it (suite/skills/next/SKILL.md).
import type { GtmBoard, GtmStep } from '../types'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type Config = { [key: string]: Json }

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export const PACKS: Record<string, string> = {
  '/gtm:setup': 'gtm',
  '/psp:psp': 'psp',
  '/evp:evp': 'evp',
  '/prospect-list:who-to-contact': 'prospect-list',
  '/cold-email:cold-email': 'cold-email',
  '/sales-offer:cold-offer': 'sales-offer',
  '/pricing:pricing': 'pricing',
  '/landing-page:page': 'landing-page',
  '/email-sequence:lifecycle-email': 'email-sequence',
  '/geo:geo': 'geo',
  '/founder-brand:founder-brand': 'founder-brand',
}

export function field(config: Config, path: string): Json | undefined {
  let at: Json | undefined = config
  for (const part of path.split('.')) {
    if (at === null || typeof at !== 'object' || Array.isArray(at)) return undefined
    at = at[part]
  }
  return at
}

export function isFilled(value: Json | undefined): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.values(value).some(isFilled)
  return true
}

export function parseConfig(text: string | undefined): Config | undefined {
  if (text === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Config)
      : undefined
  } catch {
    return undefined
  }
}

export type ScanInput = {
  config: Config | undefined
  hasConfigFile: boolean
  gtmFiles: string[]
  hasGtmDir: boolean
  newestDraftMs: number
  now: number
}

export function buildBoard(input: ScanInput): GtmBoard {
  const c = input.config ?? {}
  const has = (name: string) => input.gtmFiles.includes(name)
  const filled = (path: string) => isFilled(field(c, path))
  const text = (path: string) => {
    const value = field(c, path)
    return typeof value === 'string' ? value : ''
  }

  const step = (
    n: number,
    name: string,
    check: string,
    command: string,
    why: string,
    isDone: boolean,
  ): GtmStep => ({ n, name, check, command, why, isDone })

  const steps: GtmStep[] = [
    step(0, 'Setup', 'operator.name + icp.segment', '/gtm:setup',
      'no operator or buyer segment yet', filled('operator.name') && filled('icp.segment')),
    step(1, 'Profile (PSP)', 'psp.primary_pain + psp.signal_anchors', '/psp:psp',
      'no locked pain signal profile yet', filled('psp.primary_pain') && filled('psp.signal_anchors')),
    step(2, 'Value line (EVP)', 'evp.primary', '/evp:evp',
      'no value line yet', filled('evp.primary')),
    step(3, 'Prospect list', 'gtm/list.json', '/prospect-list:who-to-contact',
      'no list of who to contact', has('list.json')),
    step(4, 'First touch', 'gtm/letter.json or tone + infrastructure', '/cold-email:cold-email',
      'no first-touch letter yet', has('letter.json') || (filled('tone') && filled('infrastructure'))),
    step(5, 'Offer', 'gtm/offer.json', '/sales-offer:cold-offer',
      'no give-first offer yet', has('offer.json')),
    step(6, 'Pricing', 'pricing.currentTiers or gtm/price.json', '/pricing:pricing',
      'no price tiers yet', filled('pricing.currentTiers') || has('price.json')),
    step(7, 'Landing page', 'gtm/page.json', '/landing-page:page',
      'no landing page draft yet', has('page.json')),
    step(8, 'Email sequence', 'gtm/sequence.json', '/email-sequence:lifecycle-email',
      'no opt-in sequence yet', has('sequence.json')),
    step(9, 'Findability (GEO)', 'gtm/findability.json', '/geo:geo',
      'no findability check yet', has('findability.json')),
    step(10, 'Founder posts', 'drafts/ post in last 7 days', '/founder-brand:founder-brand',
      'no founder post this week',
      input.newestDraftMs > 0 && input.now - input.newestDraftMs <= WEEK_MS),
  ]

  return {
    hasProject: input.hasConfigFile || input.hasGtmDir,
    steps,
    operator: [text('operator.name'), text('operator.company')].filter(Boolean).join(', '),
    segment: text('icp.segment'),
    pain: text('psp.primary_pain'),
    valueLine: text('evp.primary'),
    checkedAt: input.now,
  }
}

export function nextStep(board: GtmBoard): GtmStep | undefined {
  return board.steps.find(one => !one.isDone)
}

export function doneCount(board: GtmBoard): number {
  return board.steps.filter(one => one.isDone).length
}

export function summary(board: GtmBoard): string {
  const next = nextStep(board)
  const done = board.steps.filter(one => one.isDone).map(one => one.n).join(', ') || 'none'
  const nextLine = next === undefined
    ? 'Next: every step has its file or field. Refresh the founder post weekly.'
    : `Next: ${next.command} — ${next.why} (checks ${next.check})`
  return `Done: ${done}\n${nextLine}`
}

// Merge, never overwrite: every filled value in the old config must survive.
function sameJson(a: Json | undefined, b: Json | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function mergeViolations(before: Config, after: Config, prefix = ''): string[] {
  const lost: string[] = []
  for (const [key, old] of Object.entries(before)) {
    if (!isFilled(old)) continue
    const path = prefix + key
    const now = after[key]
    if (old !== null && typeof old === 'object' && !Array.isArray(old)) {
      if (now === null || typeof now !== 'object' || Array.isArray(now)) {
        lost.push(path)
      } else {
        lost.push(...mergeViolations(old, now, `${path}.`))
      }
    } else if (Array.isArray(old)) {
      const kept = Array.isArray(now) && old.every(item => now.some(one => sameJson(one, item)))
      if (!kept) lost.push(path)
    } else if (!sameJson(old, now)) {
      lost.push(path)
    }
  }
  return lost
}

export function soulSections(text: string): string[] {
  return text
    .split('\n')
    .filter(line => /^##\s+\S/.test(line))
    .map(line => line.replace(/^##\s+/, '').trim())
}

export function soulViolations(before: string, after: string): string[] {
  const kept = new Set(soulSections(after))
  return soulSections(before).filter(name => !kept.has(name))
}

export function applyEdit(
  text: string,
  oldString: string,
  newString: string,
  isAll: boolean,
): string | undefined {
  if (!text.includes(oldString)) return undefined
  return isAll ? text.split(oldString).join(newString) : text.replace(oldString, () => newString)
}
