// Analytics over the score history, the outcome log and the weekly digest.
// Pure: register.tsx reads the store and hands the data in.
import type { Finding, History, Outcome, PackId, Sample, Scores } from '../types'
import { PACKS } from './packs'
import { scoreLabel } from './score'

export type PackStats = {
  pack: PackId
  samples: number
  first?: number
  last?: number
  /** Failing runs before the first pass; undefined if it never passed. */
  draftsToPass?: number
  /** ms from the first scored run to the first pass. */
  timeToPass?: number
  /** Fix lines that went away between runs. */
  fixesResolved: number
}

const scored = (samples: readonly Sample[]) => samples.filter(one => one.status === 'pass' || one.status === 'fail')

export function packStats(pack: PackId, samples: readonly Sample[]): PackStats {
  const runs = scored(samples)
  const firstPass = runs.findIndex(one => one.status === 'pass')
  const numbers = runs.filter(one => one.score !== undefined)
  let fixesResolved = 0
  for (let i = 1; i < runs.length; i += 1) {
    const drop = (runs[i - 1]?.fixes ?? 0) - (runs[i]?.fixes ?? 0)
    if (drop > 0) fixesResolved += drop
  }
  return {
    pack,
    samples: runs.length,
    ...(numbers[0]?.score !== undefined ? { first: numbers[0].score } : {}),
    ...(numbers.at(-1)?.score !== undefined ? { last: numbers.at(-1)?.score } : {}),
    ...(firstPass >= 0 ? { draftsToPass: firstPass, timeToPass: (runs[firstPass]?.at ?? 0) - (runs[0]?.at ?? 0) } : {}),
    fixesResolved,
  }
}

export function allStats(history: History): PackStats[] {
  return PACKS.map(pack => packStats(pack.id, history[pack.id] ?? [])).filter(one => one.samples > 0)
}

export function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`
}

/** The $.store key for one project's outcome log. */
export function outcomesKey(root: string): string {
  return `outcomes:${root}`
}

/** Adds an outcome entry; a count that is not a whole number of 0 or more is refused. */
export function addOutcome(log: readonly Outcome[], entry: Outcome): Outcome[] | undefined {
  if (!Number.isInteger(entry.count) || entry.count < 0) return undefined
  return [...log, entry].slice(-200)
}

/** Totals per letter version: replies and meetings logged while that version was live. */
export function outcomesByVersion(log: readonly Outcome[]): { version: string; score?: number; replies: number; meetings: number }[] {
  const rows = new Map<string, { version: string; score?: number; replies: number; meetings: number }>()
  for (const entry of log) {
    const row = rows.get(entry.version) ?? { version: entry.version, replies: 0, meetings: 0 }
    if (entry.kind === 'replies') row.replies += entry.count
    else row.meetings += entry.count
    if (entry.score !== undefined) row.score = entry.score
    rows.set(entry.version, row)
  }
  return [...rows.values()]
}

const WEEK = 7 * 86_400_000

const date = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** The weekly digest, as Markdown. */
export function digest(input: {
  now: number
  history: History
  scores: Scores
  findings: readonly Finding[]
  outcomes: readonly Outcome[]
  nextCommand?: string
}): string {
  const since = input.now - WEEK
  const lines = [`# GTM weekly digest, ${date(since)} to ${date(input.now)}`, '']

  const moved = PACKS.flatMap(pack => {
    const week = scored(input.history[pack.id] ?? []).filter(one => one.at >= since)
    const before = scored(input.history[pack.id] ?? []).filter(one => one.at < since).at(-1)
    const start = before ?? week[0]
    const end = week.at(-1)
    if (start === undefined || end === undefined || week.length === 0) return []
    const from = start.score ?? start.status
    const to = end.score ?? end.status
    return from === to ? [`- ${pack.name}: ${to} (no change)`] : [`- ${pack.name}: ${from} → ${to}`]
  })
  lines.push('## What moved', ...(moved.length > 0 ? moved : ['- No drafts were scored this week.']), '')

  const failing = PACKS.flatMap(pack => {
    const score = input.scores[pack.id]
    if (score?.status !== 'fail') return []
    return [`- ${pack.name}: ${scoreLabel(score)}${score.fixes[0] ? `. First fix: ${score.fixes[0]}` : ''}`]
  })
  lines.push('## What needs work', ...(failing.length > 0 ? failing : ['- Every scored draft passes.']), '')

  const resolved = allStats(input.history).reduce((sum, one) => sum + one.fixesResolved, 0)
  lines.push(`Fixes resolved so far: ${resolved}.`, '')

  if (input.findings.length > 0) {
    lines.push('## Cross-pack warnings', ...input.findings.map(one => `- ${one.message}`), '')
  }

  const week = input.outcomes.filter(one => one.at >= since)
  if (week.length > 0) {
    const replies = week.filter(one => one.kind === 'replies').reduce((sum, one) => sum + one.count, 0)
    const meetings = week.filter(one => one.kind === 'meetings').reduce((sum, one) => sum + one.count, 0)
    lines.push('## Outcomes you logged', `- Replies: ${replies}`, `- Meetings: ${meetings}`, '')
  }

  if (input.nextCommand) lines.push(`Next: ${input.nextCommand}`)
  return `${lines.join('\n').trimEnd()}\n`
}

// --- Guided sprint ---------------------------------------------------------

export type SprintVerdict =
  | { kind: 'advance'; next: PackId }
  | { kind: 'done' }
  | { kind: 'pause'; reason: string }

/** After a sprint step's turn: go on to the next pack, finish, or pause on a failing draft. */
export function sprintStep(current: PackId, target: number, scores: Scores): SprintVerdict {
  const pack = PACKS.find(one => one.id === current)
  if (pack === undefined) return { kind: 'pause', reason: `unknown step ${current}` }
  const score = scores[pack.id]
  if (score === undefined || score.status === 'missing') {
    return { kind: 'pause', reason: `${pack.name} has no draft yet` }
  }
  if (score.status === 'fail') {
    return { kind: 'pause', reason: `${pack.name} fails its scorer (${scoreLabel(score)})` }
  }
  const next = PACKS.find(one => one.step > pack.step && one.step <= target)
  return next === undefined ? { kind: 'done' } : { kind: 'advance', next: next.id }
}
