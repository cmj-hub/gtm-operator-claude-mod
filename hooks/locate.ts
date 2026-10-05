// Where a pack's scorer can live on this machine. The hooks module walks the
// directories (it holds $); this file only says which paths to try, in order.
import type { PackDef } from './packs'

export type Bases = {
  home: string | undefined
  root: string
  /** The packsDir setting: a folder holding the pack repos. */
  packsDir: string
  /** Installed plugin version folders per plugin name, newest first. */
  cacheVersions: Readonly<Record<string, readonly string[]>>
}

const join = (...parts: string[]) =>
  parts.filter(part => part !== '').join('/').replace(/\/+/g, '/')

/** Repo-root folders that may hold this pack, best first. */
export function repoRoots(pack: PackDef, bases: Bases): string[] {
  const roots: string[] = []
  if (bases.packsDir !== '') {
    roots.push(join(bases.packsDir, pack.repo), join(bases.packsDir, pack.plugin))
  }
  roots.push(...(bases.cacheVersions[pack.plugin] ?? []))
  return roots
}

/** Installed skill folders that may hold this pack, best first. */
export function skillRoots(pack: PackDef, bases: Bases): string[] {
  const roots = [join(bases.root, '.claude/skills', pack.skill)]
  if (bases.home !== undefined) {
    roots.push(join(bases.home, '.claude/skills', pack.skill), join(bases.home, '.agents/skills', pack.skill))
  }
  return roots
}

/** Every path to try for the scorer, in order. */
export function scorerCandidates(pack: PackDef, bases: Bases): string[] {
  const inSkill = pack.skillScorer ?? pack.scorer
  const fileName = pack.scorer.slice(pack.scorer.lastIndexOf('/') + 1)
  const paths = [
    ...repoRoots(pack, bases).map(root => join(root, pack.scorer)),
    ...skillRoots(pack, bases).flatMap(root => [join(root, inSkill), join(root, 'scripts', fileName)]),
  ]
  return [...new Set(paths)]
}

/** Sorts version folder names newest first (semver-ish, then by name). */
export function newestFirst(names: readonly string[]): string[] {
  const parts = (name: string) => name.split(/[.-]/).map(part => (/^\d+$/.test(part) ? Number(part) : part))
  return [...names].sort((a, b) => {
    const pa = parts(a)
    const pb = parts(b)
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const x = pa[i]
      const y = pb[i]
      if (x === y) continue
      if (x === undefined) return 1
      if (y === undefined) return -1
      if (typeof x === 'number' && typeof y === 'number') return y - x
      return String(y).localeCompare(String(x))
    }
    return 0
  })
}
