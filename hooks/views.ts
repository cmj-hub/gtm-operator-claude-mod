// View models for the pack views. Each reads a pack's own files or tool
// output and returns plain data; register.tsx draws it.
import type { DraftFile } from './drift'
import { listEntries } from './drift'
import { field } from './gtm'
import type { Config } from './gtm'
import { parseJson } from './score'

const str = (value: unknown) => (typeof value === 'string' ? value : '')
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

function parseAny(textValue: string | undefined): unknown {
  if (textValue === undefined) return undefined
  const start = textValue.search(/[[{]/)
  if (start < 0) return undefined
  try {
    return JSON.parse(textValue.slice(start)) as unknown
  } catch {
    return undefined
  }
}

// --- Pricing ---------------------------------------------------------------

export type LeakStep = { name: string; leak: number }
export type CustomerLeak = { id: string; list: number; pocket: number; leakPct: number; steps: LeakStep[] }
export type TierCheck = { rule: string; passed: boolean; detail: string }
export type PricingView = {
  customers: CustomerLeak[]
  totalList: number
  totalPocket: number
  /** Leak by discount step across customers, largest first. */
  byStep: LeakStep[]
  tiersScore?: number
  checks: TierCheck[]
  contrastSet: string[]
  valueMetric: string
}

export function pricingView(waterfall: string | undefined, decoy: string | undefined, price: DraftFile | undefined): PricingView {
  const wf = parseJson(waterfall ?? '')
  const rows = Array.isArray(wf?.per_customer) ? wf.per_customer : []
  const customers: CustomerLeak[] = rows.flatMap(row => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return []
    const list = num(row.list_price_annual) ?? 0
    const pocket = num(row.pocket_price_annual) ?? 0
    const steps = Array.isArray(row.leak_by_step)
      ? row.leak_by_step.flatMap(step => (step && typeof step === 'object' && !Array.isArray(step)
          ? [{ name: str(step.name), leak: num(step.dollar_leak) ?? 0 }] : []))
      : []
    return [{ id: str(row.customer_id), list, pocket, leakPct: num(row.leak_pct) ?? 0, steps }]
  })
  const byStepMap = new Map<string, number>()
  for (const customer of customers) {
    for (const step of customer.steps) byStepMap.set(step.name, (byStepMap.get(step.name) ?? 0) + step.leak)
  }
  const dv = parseJson(decoy ?? '')
  const checks = Array.isArray(dv?.checks)
    ? dv.checks.flatMap(check => (check && typeof check === 'object' && !Array.isArray(check)
        ? [{ rule: str(check.rule), passed: check.passed === true, detail: str(check.detail) }] : []))
    : []
  const priceDraft = parseAny(price?.text) as Record<string, unknown> | undefined
  return {
    customers,
    totalList: customers.reduce((sum, one) => sum + one.list, 0),
    totalPocket: customers.reduce((sum, one) => sum + one.pocket, 0),
    byStep: [...byStepMap].map(([name, leak]) => ({ name, leak })).sort((a, b) => b.leak - a.leak),
    ...(num(dv?.score) !== undefined ? { tiersScore: num(dv?.score) } : {}),
    checks,
    contrastSet: Array.isArray(priceDraft?.contrast_set) ? priceDraft.contrast_set.filter((one): one is string => typeof one === 'string') : [],
    valueMetric: str(priceDraft?.value_metric),
  }
}

// --- Prospect board --------------------------------------------------------

export type Prospect = { title: string; signal: string }
export type ProspectBoard = { call: Prospect[]; hold: Prospect[]; drop: Prospect[]; unscored: Prospect[] }

export function prospectBoard(list: DraftFile | undefined): ProspectBoard {
  const board: ProspectBoard = { call: [], hold: [], drop: [], unscored: [] }
  for (const entry of listEntries(list)) {
    const prospect = { title: str(entry.title) || str(entry.name) || str(entry.company), signal: str(entry.signal) }
    const slot = str(entry.score).toLowerCase()
    if (slot.startsWith('call')) board.call.push(prospect)
    else if (slot === 'hold') board.hold.push(prospect)
    else if (slot === 'drop') board.drop.push(prospect)
    else board.unscored.push(prospect)
  }
  return board
}

// --- Cold email ------------------------------------------------------------

export type ColdEmailView = {
  subject: string
  signal: string
  words: number
  spamScore?: number
  spamVerdict: string
  subjectScore?: number
  domain: string
  /** Reply triage counts by category. */
  replies: Record<string, number>
  deliverability?: { isRun: boolean; ok: boolean; lines: string[] }
  /** The sending rhythm, Mon to Fri, with today marked. */
  rhythm: { day: string; isSendDay: boolean; isToday: boolean }[]
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']

export function sendingDomain(config: Config): string {
  const infra = field(config, 'infrastructure')
  if (infra === null || typeof infra !== 'object' || Array.isArray(infra)) return ''
  const direct = str(infra.sending_domain) || str(infra.domain)
  if (direct !== '') return direct
  const any = Object.values(infra).find(value => typeof value === 'string' && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value))
  return str(any)
}

export function coldEmailView(input: {
  letter: DraftFile | undefined
  config: Config
  spam?: string
  subject?: string
  replies?: string
  deliverability?: { exitCode: number; stdout: string; stderr: string }
  now: number
}): ColdEmailView {
  const letter = (parseAny(input.letter?.text) ?? {}) as Record<string, unknown>
  const body = str(letter.letter) || str(letter.body)
  const spam = parseJson(input.spam ?? '')
  const subject = parseJson(input.subject ?? '')
  const replyRows = parseAny(input.replies)
  const replies: Record<string, number> = {}
  if (Array.isArray(replyRows)) {
    for (const row of replyRows) {
      const category = row && typeof row === 'object' ? str((row as { category?: unknown }).category) : ''
      if (category !== '') replies[category] = (replies[category] ?? 0) + 1
    }
  }
  const rhythmSetting = str(field(input.config, 'operations.rhythm')) || str(field(input.config, 'operations.send_days'))
  const sendDays = rhythmSetting === '' ? ['Mon', 'Wed', 'Fri'] : DAYS.filter(day => rhythmSetting.toLowerCase().includes(day.toLowerCase()))
  const today = DAYS[(new Date(input.now).getUTCDay() + 6) % 7]
  let deliverability: ColdEmailView['deliverability']
  if (input.deliverability !== undefined) {
    const parsed = parseJson(input.deliverability.stdout)
    const checks = Array.isArray(parsed?.checks) ? parsed.checks : []
    const lines = checks.length > 0
      ? checks.flatMap(check => (check && typeof check === 'object' && !Array.isArray(check)
          ? [`${check.status === 'pass' ? '✓' : check.status === 'fail' ? '✗' : '?'} ${str(check.name)}${str(check.detail) ? `: ${str(check.detail)}` : ''}`] : []))
      : [(input.deliverability.stderr || input.deliverability.stdout).split('\n')[0] ?? 'no output']
    deliverability = { isRun: parsed !== undefined, ok: input.deliverability.exitCode === 0, lines }
  }
  return {
    subject: str(letter.subject) || str(subject?.subject),
    signal: str(letter.public_signal),
    words: body === '' ? 0 : body.trim().split(/\s+/).length,
    ...(num(spam?.score) !== undefined ? { spamScore: num(spam?.score) } : {}),
    spamVerdict: str(spam?.verdict),
    ...(num(subject?.score) !== undefined ? { subjectScore: num(subject?.score) } : {}),
    domain: sendingDomain(input.config),
    replies,
    ...(deliverability ? { deliverability } : {}),
    rhythm: DAYS.map(day => ({ day, isSendDay: sendDays.includes(day), isToday: day === today })),
  }
}

// --- EVP ladder ------------------------------------------------------------

export const TIERS = ['Unaware', 'Problem-aware', 'Solution-aware', 'Product-aware', 'Most aware'] as const

export type EvpRung = { tier: number; name: string; lines: string[]; isChosen: boolean }

export function evpLadder(config: Config): { primary: string; rungs: EvpRung[] } {
  const chosenTier = Number(field(config, 'evp.tier') ?? 0)
  const primary = str(field(config, 'evp.primary'))
  const drafts = field(config, 'evp_drafts')
  const byTier = new Map<number, string[]>()
  const add = (tier: number, line: string) => {
    if (tier >= 1 && tier <= 5 && line !== '') byTier.set(tier, [...(byTier.get(tier) ?? []), line])
  }
  if (Array.isArray(drafts)) {
    for (const one of drafts) {
      if (one && typeof one === 'object' && !Array.isArray(one)) add(Number(one.tier ?? 0), str(one.evp) || str(one.line) || str(one.primary) || str(one.text))
    }
  } else if (drafts && typeof drafts === 'object') {
    for (const [key, value] of Object.entries(drafts)) {
      const tier = Number(key.replace(/\D/g, ''))
      for (const line of Array.isArray(value) ? value : [value]) add(tier, str(line))
    }
  }
  if (primary !== '' && chosenTier >= 1 && !(byTier.get(chosenTier) ?? []).includes(primary)) add(chosenTier, primary)
  return {
    primary,
    rungs: TIERS.map((name, index) => ({ tier: index + 1, name, lines: byTier.get(index + 1) ?? [], isChosen: chosenTier === index + 1 })),
  }
}

// --- GEO -------------------------------------------------------------------

export type GeoView = {
  question: string
  killDate: string
  daysLeft?: number
  engines: { engine: string; status: string; cited: number }[]
  blockedBots: string[]
  isIndexable?: boolean
}

export function geoView(findability: DraftFile | undefined, now: number): GeoView | undefined {
  const parsed = parseAny(findability?.text) as Record<string, unknown> | undefined
  if (parsed === undefined) return undefined
  const artifact = (parsed.artifact && typeof parsed.artifact === 'object' ? parsed.artifact : parsed) as Record<string, unknown>
  const brief = (artifact.brief ?? {}) as Record<string, unknown>
  const killDate = str(artifact.kill_date) || str(brief.kill_date)
  const killMs = killDate === '' ? NaN : Date.parse(`${killDate}T00:00:00Z`)
  const record = (artifact.citation_record ?? {}) as Record<string, unknown>
  const observations = Array.isArray(record.observations) ? record.observations : []
  const engines = new Map<string, { status: string; cited: number }>()
  for (const one of observations) {
    if (!one || typeof one !== 'object') continue
    const row = one as Record<string, unknown>
    const engine = str(row.engine)
    const cited = Array.isArray(row.cited_urls) ? row.cited_urls.length : 0
    const was = engines.get(engine)
    engines.set(engine, { status: str(row.brand_status) || was?.status || '', cited: (was?.cited ?? 0) + cited })
  }
  const pass = (artifact.indexability_pass ?? {}) as Record<string, unknown>
  const robots = (pass.robots ?? {}) as Record<string, unknown>
  return {
    question: str(artifact.buyer_question),
    killDate,
    ...(Number.isFinite(killMs) ? { daysLeft: Math.ceil((killMs - now) / 86_400_000) } : {}),
    engines: [...engines].map(([engine, value]) => ({ engine, ...value })),
    blockedBots: Object.entries(robots).filter(([, value]) => value === 'blocked').map(([bot]) => bot),
    ...(typeof pass.status === 'number'
      ? { isIndexable: pass.status === 200 && pass.noindex !== true && pass.raw_html_has_answer !== false } : {}),
  }
}

// --- Founder brand ---------------------------------------------------------

export const PILLARS = ['pillar', 'proof', 'process', 'person'] as const

export type FounderView = {
  pillars: { pillar: string; lastDaysAgo?: number; count: number }[]
  postsLast28: number
  daysSinceLast?: number
  isLate: boolean
}

/** Posts from drafts/ named <YYYY-MM-DD>-<pillar>-<slug>.md (the founder-brand pack's naming). */
export function founderView(entries: readonly { name: string; mtimeMs: number }[], now: number): FounderView {
  const posts = entries.flatMap(entry => {
    const match = /^(\d{4}-\d{2}-\d{2})-([a-z]+)-/.exec(entry.name)
    const date = match?.[1] ? Date.parse(`${match[1]}T00:00:00Z`) : entry.mtimeMs
    const pillar = match?.[2] && (PILLARS as readonly string[]).includes(match[2]) ? match[2] : 'other'
    return /\.(md|txt)$/.test(entry.name) ? [{ pillar, at: Number.isFinite(date) ? date : entry.mtimeMs }] : []
  })
  const days = (at: number) => Math.max(0, Math.floor((now - at) / 86_400_000))
  const last = posts.length > 0 ? Math.max(...posts.map(one => one.at)) : undefined
  return {
    pillars: PILLARS.map(pillar => {
      const mine = posts.filter(one => one.pillar === pillar)
      const newest = mine.length > 0 ? Math.max(...mine.map(one => one.at)) : undefined
      return { pillar, count: mine.length, ...(newest !== undefined ? { lastDaysAgo: days(newest) } : {}) }
    }),
    postsLast28: posts.filter(one => days(one.at) <= 28).length,
    ...(last !== undefined ? { daysSinceLast: days(last) } : {}),
    isLate: last === undefined || days(last) > 7,
  }
}

/** A text bar for a share of a whole. */
export function shareBar(part: number, whole: number, width: number): string {
  const filled = whole > 0 ? Math.max(0, Math.min(width, Math.round((part / whole) * width))) : 0
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}

export function money(value: number): string {
  return `$${Math.round(value).toLocaleString('en-US')}`
}
