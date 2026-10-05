// What no single pack can see: drafts built on an older PSP, EVP or price,
// drafts that disagree with each other, and buyers the list leaves out.
// Every check is a heuristic, so every finding is a warning.
import type { Finding, PackId } from '../types'
import { field } from './gtm'
import type { Config } from './gtm'
import { packById } from './packs'
import { draftText } from './voice'

/** Shared upstream inputs a draft is built from. */
export type Upstream = 'psp' | 'evp' | 'price'

/** Which upstream inputs each draft reads (the suite README's reads table). */
export const READS: Partial<Record<PackId, readonly Upstream[]>> = {
  list: ['psp'],
  letter: ['psp', 'evp'],
  offer: ['psp', 'evp'],
  price: ['psp'],
  page: ['evp', 'price'],
  sequence: ['psp', 'evp'],
  findability: ['psp'],
}

const UPSTREAM_NAME: Record<Upstream, string> = { psp: 'PSP', evp: 'EVP', price: 'price' }

export type DraftFile = { text: string; mtimeMs: number }

export type Snapshot = {
  config: Config
  /** Drafts by pack, when present. */
  drafts: Partial<Record<PackId, DraftFile>>
  /** When each upstream input last changed, ms; 0 when unknown. */
  changedAt: Partial<Record<Upstream, number>>
}

const ago = (ms: number) => {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`
}

export function staleFindings(snapshot: Snapshot): Finding[] {
  const findings: Finding[] = []
  for (const [id, reads] of Object.entries(READS) as [PackId, readonly Upstream[]][]) {
    const draft = snapshot.drafts[id]
    const pack = packById(id)
    if (draft === undefined || pack === undefined) continue
    const newer = reads.filter(up => (snapshot.changedAt[up] ?? 0) > draft.mtimeMs)
    if (newer.length === 0) continue
    const latest = Math.max(...newer.map(up => snapshot.changedAt[up] ?? 0))
    const names = newer.map(up => UPSTREAM_NAME[up]).join(' and ')
    findings.push({
      id: `stale-${id}`,
      kind: 'stale',
      packs: [id],
      message: `${pack.name} was written before your ${names} changed (${ago(latest - draft.mtimeMs)} later).`,
      fix: `${pack.command} Update the draft to match the current ${names} in brand-config.json.`,
    })
  }
  return findings
}

const STOP = new Set(['about', 'after', 'again', 'their', 'there', 'these', 'those', 'which', 'while', 'with', 'without',
  'from', 'that', 'this', 'what', 'when', 'where', 'your', 'have', 'into', 'than', 'then', 'they', 'them', 'were',
  'will', 'would', 'could', 'should', 'does', 'only', 'just', 'more', 'most', 'over', 'such', 'very', 'also'])

export function contentWords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []).filter(word => !STOP.has(word)))
}

function overlap(a: string, b: string): number {
  const wordsA = contentWords(a)
  const wordsB = contentWords(b)
  if (wordsA.size === 0) return 1
  let shared = 0
  for (const word of wordsA) if (wordsB.has(word)) shared += 1
  return shared / wordsA.size
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')

function parse(draft: DraftFile | undefined): unknown {
  if (draft === undefined) return undefined
  try {
    return JSON.parse(draft.text) as unknown
  } catch {
    return undefined
  }
}

/** Tier names from gtm/price.json (contrast_set) or gtm/tiers.json shapes. */
function tierNames(price: unknown): string[] {
  if (price === null || typeof price !== 'object') return []
  const record = price as Record<string, unknown>
  if (Array.isArray(record.contrast_set)) return record.contrast_set.filter((one): one is string => typeof one === 'string')
  if (Array.isArray(record.tiers)) {
    return record.tiers.flatMap(one => (one && typeof one === 'object' && typeof (one as { name?: unknown }).name === 'string'
      ? [(one as { name: string }).name] : []))
  }
  return []
}

/** Vocabulary phrases from the PSP block (an array, or a comma list). */
export function vocabulary(config: Config): string[] {
  const value = field(config, 'psp.vocabulary')
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,;\n]/) : []
  return list.map(one => (typeof one === 'string' ? one.trim() : '')).filter(one => one.length >= 3)
}

export function consistencyFindings(snapshot: Snapshot): Finding[] {
  const findings: Finding[] = []
  const evp = text(field(snapshot.config, 'evp.primary'))
  const page = snapshot.drafts.page
  if (evp !== '' && page !== undefined && overlap(evp, draftText(page.text)) < 0.25) {
    findings.push({
      id: 'page-evp',
      kind: 'consistency',
      packs: ['page', 'evp'],
      message: 'The landing page shares few words with your EVP line, so the page may not lead with it.',
      fix: `/landing-page:page Make the page's offer lead with the EVP line: "${evp}"`,
    })
  }

  const tiers = tierNames(parse(snapshot.drafts.price))
  if (tiers.length > 0 && page !== undefined) {
    const pageText = draftText(page.text).toLowerCase()
    const missing = tiers.filter(name => !pageText.includes(name.toLowerCase()))
    if (missing.length > 0) {
      findings.push({
        id: 'page-tiers',
        kind: 'consistency',
        packs: ['page', 'price'],
        message: `Price tiers missing from the landing page: ${missing.join(', ')}.`,
        fix: `/landing-page:page Name the price tiers from gtm/price.json on the page: ${tiers.join(', ')}.`,
      })
    }
  }

  const phrases = vocabulary(snapshot.config)
  for (const id of ['letter', 'sequence'] as const) {
    const draft = snapshot.drafts[id]
    const pack = packById(id)
    if (draft === undefined || pack === undefined || phrases.length === 0) continue
    const body = draftText(draft.text).toLowerCase()
    if (!phrases.some(phrase => body.includes(phrase.toLowerCase()))) {
      findings.push({
        id: `vocabulary-${id}`,
        kind: 'consistency',
        packs: [id, 'psp'],
        message: `${pack.name} uses none of the buyer's words from your PSP (${phrases.slice(0, 3).map(one => `"${one}"`).join(', ')}).`,
        fix: `${pack.command} Use at least one of the buyer's own phrases from psp.vocabulary: ${phrases.join(', ')}.`,
      })
    }
  }
  return findings
}

/** Entries in gtm/list.json: one object or an array of them. */
export function listEntries(list: DraftFile | undefined): Record<string, unknown>[] {
  const parsed = parse(list)
  const items = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object'
    ? (Array.isArray((parsed as { accounts?: unknown }).accounts) ? (parsed as { accounts: unknown[] }).accounts : [parsed])
    : []
  return items.filter((one): one is Record<string, unknown> => one !== null && typeof one === 'object')
}

export function coverageFindings(snapshot: Snapshot): Finding[] {
  const roles = field(snapshot.config, 'icp.role_targets')
  const list = snapshot.drafts.list
  if (!Array.isArray(roles) || list === undefined) return []
  const titles = listEntries(list).map(one => `${text(one.title)} ${text(one.role)}`.toLowerCase())
  const missing = roles
    .filter((role): role is string => typeof role === 'string' && role.trim() !== '')
    .filter(role => {
      const words = [...contentWords(role), ...(role.toLowerCase().match(/\b[a-z]{2,3}\b/g) ?? [])]
      return !titles.some(title => words.some(word => new RegExp(`\\b${word}\\b`).test(title)))
    })
  return missing.length === 0 ? [] : [{
    id: 'coverage-roles',
    kind: 'coverage',
    packs: ['list'],
    message: `No prospect on the list for: ${missing.join(', ')} (from icp.role_targets).`,
    fix: `/prospect-list:who-to-contact Add accounts with a signal for: ${missing.join(', ')}.`,
  }]
}

export function allFindings(snapshot: Snapshot): Finding[] {
  return [...staleFindings(snapshot), ...consistencyFindings(snapshot), ...coverageFindings(snapshot)]
}

/** A stable hash of a JSON value, for noticing when a block changes. */
export function hashOf(value: unknown): string {
  const textValue = JSON.stringify(value ?? null)
  let hash = 5381
  for (let i = 0; i < textValue.length; i += 1) hash = ((hash << 5) + hash + textValue.charCodeAt(i)) | 0
  return (hash >>> 0).toString(36)
}
