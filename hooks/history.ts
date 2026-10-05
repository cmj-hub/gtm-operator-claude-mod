// Score history per project and pack, kept in $.store across sessions.
import type { History, PackId, Sample } from '../types'

const KEEP = 60

/** The $.store key for one project's history. */
export function historyKey(root: string): string {
  return `history:${root}`
}

/** Adds a sample, skipping one identical to the last, and keeps the newest 60. */
export function addSample(history: History, pack: PackId, sample: Sample): History {
  const list = history[pack] ?? []
  const last = list[list.length - 1]
  const isSame = last !== undefined && last.score === sample.score && last.status === sample.status &&
    last.fixes === sample.fixes
  if (isSame) return history
  return { ...history, [pack]: [...list, sample].slice(-KEEP) }
}

const BLOCKS = '▁▂▃▄▅▆▇█'

/** A one-line trend of scores; pass counts as 100 and fail as 0 when no number. */
export function sparkline(samples: readonly Sample[], width = 16): string {
  const values = samples
    .filter(one => one.status === 'pass' || one.status === 'fail')
    .map(one => one.score ?? (one.status === 'pass' ? 100 : 0))
    .slice(-width)
  return values.map(value => BLOCKS[Math.min(7, Math.floor((value / 100) * 7.999))]).join('')
}

/** Change between the first and last numbered score, if both exist. */
export function trend(samples: readonly Sample[]): number | undefined {
  const scored = samples.filter(one => one.score !== undefined)
  const first = scored[0]?.score
  const last = scored[scored.length - 1]?.score
  return first !== undefined && last !== undefined && scored.length > 1 ? last - first : undefined
}
