// One score shape for every pack's scorer. Scorers print JSON with --json, but
// each names its verdict differently (ok, pass, total/max_total) and its
// problems differently (reasons, failures, problems, blockers).
import type { Axis, PackId, Score } from '../types'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Obj = { [key: string]: Json }

const isObj = (value: unknown): value is Obj =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function text(value: Json | undefined): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value.trim()
  if (isObj(value)) {
    const head = text(value.message) ?? text(value.problem) ?? text(value.check)
    const field = text(value.field)
    const detail = text(value.detail)
    const line = [field && head ? `${field}: ${head}` : head ?? field, detail].filter(Boolean).join(' (')
    return line === '' ? undefined : detail ? `${line})` : line
  }
  return undefined
}

function lines(value: Json | undefined): string[] {
  return Array.isArray(value) ? value.map(text).filter((one): one is string => one !== undefined) : []
}

/** Fixes nested inside problem objects (sales offer, GEO). */
function nestedFixes(value: Json | undefined): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(one => (isObj(one) && typeof one.fix === 'string' ? [one.fix] : []))
}

/** The first JSON object in a scorer's stdout, or undefined. */
export function parseJson(stdout: string): Obj | undefined {
  const start = stdout.indexOf('{')
  if (start < 0) return undefined
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start))
    return isObj(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export function normalize(pack: PackId, stdout: string, exitCode: number, at: number): Score {
  const raw = parseJson(stdout)
  if (raw === undefined) {
    return {
      pack,
      status: 'unknown',
      reasons: [],
      fixes: [],
      axes: [],
      detail: exitCode === 0 ? 'the scorer printed no JSON' : `the scorer exited ${exitCode} with no JSON`,
      at,
    }
  }

  const total = typeof raw.total === 'number' ? raw.total : undefined
  const max = typeof raw.max_total === 'number' && raw.max_total > 0 ? raw.max_total : undefined
  const score = total !== undefined && max !== undefined ? Math.round((total / max) * 100) : undefined

  const verdictFlag = typeof raw.ok === 'boolean' ? raw.ok : typeof raw.pass === 'boolean' ? raw.pass : undefined
  const isPass = verdictFlag ?? exitCode === 0

  const reasons = [
    ...lines(raw.reasons),
    ...(Array.isArray(raw.reasons) ? [] : [...lines(raw.failures), ...lines(raw.problems)]),
  ]
  const fixes = [...lines(raw.fixes), ...nestedFixes(raw.failures), ...nestedFixes(raw.problems)]
  const axes: Axis[] = Array.isArray(raw.axes)
    ? raw.axes.flatMap(one =>
        isObj(one) && typeof one.name === 'string' && typeof one.score === 'number'
          ? [{
              name: one.name,
              score: one.score,
              max: typeof one.max_score === 'number' ? one.max_score : 0,
              notes: lines(one.notes),
            }]
          : [],
      )
    : []

  return {
    pack,
    status: isPass ? 'pass' : 'fail',
    ...(score !== undefined ? { score } : {}),
    reasons: [...new Set(reasons)],
    fixes: [...new Set(fixes)],
    axes,
    ...(typeof raw.next === 'string' ? { next: raw.next } : {}),
    ...(typeof raw.verdict === 'string' ? { verdict: raw.verdict } : {}),
    at,
  }
}

/** A short label for the board: "82/100 · 2 fixes", "pass", "fail · 3 fixes". */
export function scoreLabel(score: Score | undefined): string {
  if (score === undefined) return ''
  if (score.status === 'missing' || score.status === 'unknown') return score.status
  const head = score.score !== undefined ? `${score.score}/100` : score.status
  const fixCount = score.fixes.length
  return fixCount > 0 ? `${head} · ${fixCount} fix${fixCount === 1 ? '' : 'es'}` : head
}

/**
 * What a gate refusal tells Claude to change: the scorer's fixes, else its
 * reasons, else the axes furthest below their maximum. Never an empty list.
 */
export function gateLines(score: Score, limit = 5): string[] {
  if (score.fixes.length > 0) return score.fixes.slice(0, limit)
  if (score.reasons.length > 0) return score.reasons.slice(0, limit)
  const short = [...score.axes]
    .filter(axis => axis.score < axis.max)
    .sort((a, b) => a.score / a.max - b.score / b.max)
    .slice(0, limit)
    .map(axis => `raise ${axis.name} (${axis.score}/${axis.max})${axis.notes[0] ? `: ${axis.notes[0]}` : ''}`)
  return short.length > 0 ? short : ["run the pack's command to see what its scorer wants"]
}

/** The prompt "Fix with Claude" fills in. */
export function fixPrompt(command: string, score: Score): string {
  const items = score.fixes.length > 0 ? score.fixes : score.reasons
  const list = items.map(line => `- ${line}`).join('\n')
  return `${command} Fix the draft so the scorer passes. It reported:\n${list}`
}
