import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { GtmBoard, History, PackId, Score, Scores, Tab } from '../types'
import {
  PACKS as INSTALL_NAMES,
  applyEdit,
  buildBoard,
  doneCount,
  field,
  isFilled,
  mergeViolations,
  nextStep,
  parseConfig,
  soulViolations,
  summary,
} from './gtm'
import { addSample, historyKey, sparkline, trend } from './history'
import { newestFirst, scorerCandidates } from './locate'
import { PACKS, packById, packForPath } from './packs'
import type { PackDef, ScorerInput } from './packs'
import { fixPrompt, normalize, scoreLabel } from './score'
import { draftText, refusedPhrases, voiceHits } from './voice'

const PANE = 'gtm-board'
const CONFIG = 'brand-config.json'
const SOUL = 'SOUL.md'
const SCORER_TIMEOUT_MS = 20_000

const board = atom({ plugin: 'gtm-operator', key: 'board' } as const, null)
const scores = atom({ plugin: 'gtm-operator', key: 'scores' } as const, {})
const history = atom({ plugin: 'gtm-operator', key: 'history' } as const, {})
const tab = atom({ plugin: 'gtm-operator', key: 'tab' } as const, 'board')
const selected = atom({ plugin: 'gtm-operator', key: 'selected' } as const, 'psp')
const isBandHidden = atom({ plugin: 'gtm-operator', key: 'isBandHidden' } as const, false)
const isGuardOff = atom({ plugin: 'gtm-operator', key: 'isGuardOff' } as const, false)

type $ = EngineInterface

type Settings = { runScorers: boolean; minScore: number; packsDir: string; python: string }

function settingsFrom(options: PluginOptions): Settings {
  return {
    runScorers: options.runScorers !== false,
    minScore: typeof options.minScore === 'number' ? Math.max(0, Math.min(100, options.minScore)) : 0,
    packsDir: typeof options.packsDir === 'string' ? options.packsDir.replace(/\/$/, '') : '',
    python: typeof options.python === 'string' && options.python !== '' ? options.python : 'python3',
  }
}

// Module caches: rebuilt after a reload, which is cheap.
const scorerPaths = new Map<PackId, string | null>()
const scoredKeys = new Map<PackId, string>()

// The project-relative name of a path, or undefined when it lies outside the root.
function relative(path: string, root: string): string | undefined {
  const clean = path.replace(/\\/g, '/').replace(/^\.\//, '')
  const base = root.replace(/\\/g, '/').replace(/\/$/, '')
  if (clean.startsWith(`${base}/`)) return clean.slice(base.length + 1)
  return clean.startsWith('/') ? undefined : clean
}

function isTracked(rel: string | undefined): boolean {
  return rel === CONFIG || rel === SOUL || rel?.startsWith('gtm/') === true ||
    rel?.startsWith('drafts/') === true
}

const cut = (text: string, room: number) =>
  text.length <= room ? text : `${text.slice(0, Math.max(1, room - 1))}…`

async function projectRoot($: $): Promise<string> {
  return (await $.session.root()).replace(/[\\/]$/, '')
}

async function readText($: $, path: string): Promise<string | undefined> {
  return (await $.fs.exists(path)) ? await $.fs.read(path) : undefined
}

async function scan($: $): Promise<GtmBoard> {
  const root = await projectRoot($)
  const configText = await readText($, `${root}/${CONFIG}`).catch(() => undefined)
  const gtm = await $.fs.list(`${root}/gtm`).catch(() => undefined)
  const drafts = await $.fs.list(`${root}/drafts`).catch(() => [])

  return buildBoard({
    config: parseConfig(configText),
    hasConfigFile: configText !== undefined,
    gtmFiles: (gtm ?? []).filter(one => one.kind === 'file').map(one => one.name),
    hasGtmDir: gtm !== undefined,
    newestDraftMs: Math.max(0, ...drafts.filter(one => one.kind === 'file').map(one => one.mtimeMs)),
    now: await $.clock.now(),
  })
}

// --- Finding and running the packs' scorers -------------------------------

async function cacheVersions($: $, home: string | undefined): Promise<Record<string, string[]>> {
  if (home === undefined) return {}
  const cache = `${home}/.claude/plugins/cache`
  const marketplaces = await $.fs.list(cache).catch(() => [])
  const found: Record<string, string[]> = {}
  for (const marketplace of marketplaces.filter(one => one.kind === 'dir')) {
    for (const pack of PACKS) {
      const dir = `${cache}/${marketplace.name}/${pack.plugin}`
      const versions = await $.fs.list(dir).catch(() => [])
      const names = newestFirst(versions.filter(one => one.kind === 'dir').map(one => one.name))
      found[pack.plugin] = [...(found[pack.plugin] ?? []), ...names.map(name => `${dir}/${name}`)]
    }
  }
  return found
}

async function locateScorers($: $, settings: Settings): Promise<void> {
  const home = await $.env.get('HOME')
  const root = await projectRoot($)
  const versions = await cacheVersions($, home)
  for (const pack of PACKS) {
    let found: string | null = null
    for (const path of scorerCandidates(pack, { home, root, packsDir: settings.packsDir, cacheVersions: versions })) {
      if (await $.fs.exists(path).catch(() => false)) {
        found = path
        break
      }
    }
    scorerPaths.set(pack.id, found)
  }
}

type Draft = { input: ScorerInput; text: string; key: string }

/** What the pack's scorer should read, or undefined when there is no draft yet. */
async function readDraft($: $, root: string, pack: PackDef): Promise<Draft | undefined> {
  const source = pack.draft
  if (source.kind === 'file') {
    const path = `${root}/${source.path}`
    const stat = await $.fs.stat(path).catch(() => undefined)
    if (stat === undefined || stat.kind !== 'file') return undefined
    const text = (await $.fs.read(path).catch(() => '')) as string
    return { input: { file: path }, text, key: `${stat.mtimeMs}:${stat.size}` }
  }
  if (source.kind === 'latest') {
    const dir = `${root}/${source.dir}`
    const entries = await $.fs.list(dir).catch(() => [])
    const newest = entries
      .filter(one => one.kind === 'file' && source.ext.some(ext => one.name.endsWith(ext)))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
    if (newest === undefined) return undefined
    const path = `${dir}/${newest.name}`
    const text = (await $.fs.read(path).catch(() => '')) as string
    return { input: { file: path }, text, key: `${newest.name}:${newest.mtimeMs}:${newest.size}` }
  }
  const configText = await readText($, `${root}/${CONFIG}`).catch(() => undefined)
  const value = field(parseConfig(configText) ?? {}, source.field)
  if (!isFilled(value)) return undefined
  const serialized = JSON.stringify(value)
  if (source.kind === 'config-text') {
    return typeof value === 'string' ? { input: { text: value }, text: value, key: serialized } : undefined
  }
  return { input: { file: `${root}/${CONFIG}` }, text: serialized, key: serialized }
}

const installHint = (pack: PackDef) =>
  `${pack.repo} is not installed where the mod looks. Install it with /plugin install ${pack.plugin}@gtm-operator-skills, ` +
  'or set packsDir to the folder holding the pack repos.'

/** Runs one scorer on one input. Never rejects: failures come back as unknown. */
async function runScorer($: $, settings: Settings, pack: PackDef, input: ScorerInput): Promise<Score> {
  const now = await $.clock.now()
  const scorer = scorerPaths.get(pack.id)
  if (scorer === undefined || scorer === null) {
    return { pack: pack.id, status: 'unknown', reasons: [], fixes: [], axes: [], detail: installHint(pack), at: now }
  }
  const argv = [settings.python, scorer, ...pack.args(input), '--json']
  const stdin = 'stdin' in input ? input.stdin : undefined
  const ran = await $.process
    .run(argv, { timeoutMs: SCORER_TIMEOUT_MS, ...(stdin !== undefined ? { stdin } : {}) })
    .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: String(error) }))
  const score = normalize(pack.id, ran.stdout, ran.exitCode, now)
  if (score.status === 'unknown' && ran.exitCode === -1) {
    return { ...score, detail: `could not run ${settings.python}: ${ran.stderr.slice(0, 120)}` }
  }
  return score
}

async function soulPhrases($: $, root: string): Promise<string[]> {
  const soul = await readText($, `${root}/${SOUL}`).catch(() => undefined)
  return soul === undefined ? [] : refusedPhrases(soul)
}

/** Scores one pack's current draft; undefined when nothing changed since the last run. */
async function scorePack($: $, settings: Settings, pack: PackDef, isForced: boolean): Promise<Score | undefined> {
  const root = await projectRoot($)
  const draft = await readDraft($, root, pack)
  if (draft === undefined) {
    scoredKeys.delete(pack.id)
    return { pack: pack.id, status: 'missing', reasons: [], fixes: [], axes: [], at: await $.clock.now() }
  }
  const phrases = await soulPhrases($, root)
  const key = `${draft.key}|${phrases.join('|')}|${scorerPaths.get(pack.id) ?? ''}`
  if (!isForced && scoredKeys.get(pack.id) === key) return undefined
  scoredKeys.set(pack.id, key)

  const scored = settings.runScorers
    ? await runScorer($, settings, pack, draft.input)
    : { pack: pack.id, status: 'unknown' as const, reasons: [], fixes: [], axes: [], detail: 'runScorers is off', at: await $.clock.now() }
  const voice = voiceHits(draftText(draft.text), phrases)
  return { ...scored, ...(voice.length > 0 ? { voice } : {}), excerpt: draftText(draft.text).slice(0, 600) }
}

async function saveHistory($: $, root: string, next: History): Promise<void> {
  await update($, history, () => next)
  await $.store.set(historyKey(root), next)
}

/** Scores the given packs (all by default) and records what changed. */
async function scoreAll($: $, settings: Settings, only?: readonly PackDef[], isForced = false): Promise<Score[]> {
  if (scorerPaths.size === 0) await locateScorers($, settings)
  const root = await projectRoot($)
  const changed: Score[] = []
  for (const pack of only ?? PACKS) {
    const score = await scorePack($, settings, pack, isForced)
    if (score !== undefined) changed.push(score)
  }
  if (changed.length === 0) return changed

  await update($, scores, all => {
    const next: Scores = { ...all }
    for (const score of changed) next[score.pack] = score
    return next
  })
  let next = await read($, history)
  for (const score of changed) {
    if (score.status === 'pass' || score.status === 'fail') {
      next = addSample(next, score.pack, {
        at: score.at,
        ...(score.score !== undefined ? { score: score.score } : {}),
        status: score.status,
        fixes: score.fixes.length,
      })
    }
  }
  await saveHistory($, root, next)
  return changed
}

function failingCount(all: Scores): number {
  return Object.values(all).filter(one => one?.status === 'fail' || (one?.voice?.length ?? 0) > 0).length
}

function statusLine(found: GtmBoard, all: Scores): string | undefined {
  if (!found.hasProject) return undefined
  const next = nextStep(found)
  const tail = next === undefined ? 'all steps done' : `next ${next.command}`
  const failing = failingCount(all)
  const fixes = failing > 0 ? ` · ${failing} draft${failing === 1 ? '' : 's'} to fix` : ''
  return `GTM ${doneCount(found)}/${found.steps.length}${fixes} · ${tail}`
}

async function refresh($: $, settings: Settings, isAnnounced = false): Promise<GtmBoard> {
  const found = await scan($)
  const before = await read($, board)
  await update($, board, () => found)
  if (found.hasProject) await scoreAll($, settings)
  $.ui.status(statusLine(found, await read($, scores)))

  if (isAnnounced && before !== null) {
    const fresh = found.steps.filter(one => one.isDone && !before.steps[one.n]?.isDone)
    if (fresh.length > 0) {
      const next = nextStep(found)
      const names = fresh.map(one => one.name).join(', ')
      $.ui.toast(next === undefined
        ? `GTM: ${names} done. Every step is in place.`
        : `GTM: ${names} done. Next: ${next.command}`)
    }
  }
  return found
}

// The band preference and score history last across sessions; the board is rebuilt from the files.
async function restore($: $, settings: Settings): Promise<void> {
  const isHidden = (await $.store.get('isBandHidden')) === true
  await update($, isBandHidden, () => isHidden)
  const root = await projectRoot($)
  const saved = await $.store.get(historyKey(root))
  await update($, history, () => (saved !== null && typeof saved === 'object' ? (saved as History) : {}))
  scoredKeys.clear()
  scorerPaths.clear()
  await refresh($, settings)
}

async function setBandHidden($: $, isHidden: boolean): Promise<void> {
  await $.store.set('isBandHidden', isHidden)
  await update($, isBandHidden, () => isHidden)
}

async function openDetail($: $, id: PackId): Promise<void> {
  await update($, selected, () => id)
  await update($, tab, () => 'detail')
}

/** The toast after a draft is saved: its score, fixes and voice hits. */
function savedToast(pack: PackDef, score: Score): string {
  const voice = score.voice?.length ? ` · voice: ${score.voice.slice(0, 2).map(one => `"${one}"`).join(', ')}` : ''
  if (score.status === 'unknown') return `GTM ${pack.name}: not scored (${cut(score.detail ?? 'unknown', 60)})`
  const head = scoreLabel(score)
  const first = score.fixes[0] ?? score.reasons[0]
  return `GTM ${pack.name}: ${head}${voice}${score.status === 'fail' && first ? ` · ${cut(first, 70)}` : ''}`
}

// --- The guard on brand-config.json and SOUL.md -----------------------------

function guardMessage(file: string, lost: string[]): string {
  const shown = lost.slice(0, 6).join(', ') + (lost.length > 6 ? `, +${lost.length - 6} more` : '')
  return `gtm-operator: this write to ${file} would drop or change values that already exist (${shown}). ` +
    'The GTM suite merges, never overwrites: keep every existing key and value, change only the fields ' +
    'this pack owns, and ask the person before changing a field that already has a value. ' +
    'If they confirmed the change, they can run /gtm-guard off and you can retry.'
}

function failedGuard(file: string, kind: string): string {
  return `gtm-operator: the merge check on ${file} failed (${kind}), so this write was not made. ` +
    'Read the file again and retry with a change that keeps every existing value.'
}

async function guard($: $, path: string, after: string): Promise<string | undefined> {
  if (await read($, isGuardOff)) return undefined
  const root = await $.session.root()
  const rel = relative(path, root)
  if (rel !== CONFIG && rel !== SOUL) return undefined

  const before = await readText($, `${root.replace(/[\\/]$/, '')}/${rel}`).catch(() => undefined)
  if (rel === CONFIG) {
    const next = parseConfig(after)
    if (next === undefined) {
      return `gtm-operator: ${CONFIG} must stay one JSON object; this content does not parse as one.`
    }
    const old = parseConfig(before)
    const lost = old === undefined ? [] : mergeViolations(old, next)
    return lost.length > 0 ? guardMessage(CONFIG, lost) : undefined
  }

  const lost = before === undefined ? [] : soulViolations(before, after)
  return lost.length > 0 ? guardMessage(SOUL, lost.map(name => `## ${name}`)) : undefined
}

/** The score gate: refuses a draft that scores below minScore. */
async function gate($: $, settings: Settings, path: string, content: string): Promise<string | undefined> {
  if (settings.minScore <= 0 || !settings.runScorers) return undefined
  const rel = relative(path, await projectRoot($))
  const pack = rel === undefined ? undefined : packForPath(rel)
  if (pack === undefined) return undefined
  if (scorerPaths.size === 0) await locateScorers($, settings)
  if (!scorerPaths.get(pack.id)) return undefined

  const score = await runScorer($, settings, pack, { stdin: content })
  if (score.status === 'unknown') return undefined
  const value = score.score ?? (score.status === 'pass' ? 100 : 0)
  if (value >= settings.minScore) return undefined
  const fixes = (score.fixes.length > 0 ? score.fixes : score.reasons).slice(0, 5).map(one => `- ${one}`).join('\n')
  return `gtm-operator: this ${pack.name} draft scores ${score.score ?? score.status} with ${pack.repo}'s scorer, ` +
    `below the minimum of ${settings.minScore} set for this project. Fix these, then write it again:\n${fixes}`
}

// --- Drawing ---------------------------------------------------------------

function bar(value: number, max: number, width: number): string {
  const filled = max > 0 ? Math.round((value / max) * width) : 0
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`
}

export const register: Register = (on, options) => {
  const settings = settingsFrom(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'gtm-board',
      description: 'GTM suite board: what is done, how each draft scores, and the next pack to run',
      argumentHint: '[refresh]',
      immediate: true,
    })
    await $.command.register({
      name: 'gtm-score',
      description: "Score the GTM drafts with each pack's own scorer",
      argumentHint: '[pack]',
      immediate: true,
    })
    await $.command.register({
      name: 'gtm-guard',
      description: 'Turn the brand-config.json / SOUL.md overwrite guard on or off',
      argumentHint: '[on|off]',
      immediate: true,
    })
    await restore($, settings)
    $.clock.every(30_000, () => void refresh($, settings, true))

    return next(e)
  })

  // /clear, /resume and /branch reset $.state without a new session.start.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await restore($, settings)
    return next(e)
  })

  on('command.run', { command: 'gtm-board' }, async ($, e) => {
    if (e.args.trim() === 'refresh') scoredKeys.clear()
    const found = await refresh($, settings)
    if (!found.hasProject) {
      return {
        text: 'No GTM project here yet: no brand-config.json and no gtm/ folder.\n' +
          'Next: /gtm:setup — asks the shared questions once. ' +
          'Install the suite with /plugin install gtm@gtm-operator-skills.',
      }
    }
    await update($, tab, () => 'board')
    await $.ui.open({ id: PANE, title: 'GTM board' })

    return { text: summary(found) }
  })

  on('command.run', { command: 'gtm-score' }, async ($, e) => {
    const wanted = e.args.trim()
    const pack = wanted === '' ? undefined : PACKS.find(one => one.id === wanted || one.plugin === wanted)
    if (wanted !== '' && pack === undefined) {
      return { text: `Unknown pack "${wanted}". Packs: ${PACKS.map(one => one.plugin).join(', ')}.` }
    }
    await scoreAll($, settings, pack ? [pack] : undefined, true)
    const all = await read($, scores)
    const lines = (pack ? [pack] : PACKS).map(one => {
      const score = all[one.id]
      const label = score === undefined ? 'not scored' : scoreLabel(score)
      const first = score?.status === 'fail' ? ` — ${score.fixes[0] ?? score.reasons[0] ?? ''}` : ''
      const why = score?.status === 'unknown' ? ` — ${score.detail ?? ''}` : ''
      return `${one.step}. ${one.name}: ${label}${first}${why}`
    })
    return { text: lines.join('\n') }
  })

  on('command.run', { command: 'gtm-guard' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') await update($, isGuardOff, () => arg === 'off')
    const isOff = await read($, isGuardOff)

    return {
      text: isOff
        ? 'GTM guard is off: writes to brand-config.json and SOUL.md are not checked. /gtm-guard on to restore.'
        : 'GTM guard is on: a write that drops or changes an existing brand-config.json value or SOUL.md section is refused.',
    }
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const reason = (await guard($, e.file_path, e.content)) ?? (await gate($, settings, e.file_path, e.content))
    return reason === undefined ? next(e) : { deny: reason }
  }).catch(async ($, e, next) => {
    const rel = relative(e.file_path, await $.session.root())
    return rel === CONFIG || rel === SOUL ? { deny: failedGuard(rel, next.error.kind) } : next(e)
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const root = await $.session.root()
    const rel = relative(e.file_path, root)
    const isShared = rel === CONFIG || rel === SOUL
    const pack = rel === undefined ? undefined : packForPath(rel)
    if (!isShared && (pack === undefined || settings.minScore <= 0)) return next(e)
    const before = await readText($, `${root.replace(/[\\/]$/, '')}/${rel}`).catch(() => undefined)
    const after = before === undefined
      ? undefined
      : applyEdit(before, e.old_string, e.new_string, e.replace_all === true)
    const reason = after === undefined
      ? undefined
      : isShared ? await guard($, e.file_path, after) : await gate($, settings, e.file_path, after)
    return reason === undefined ? next(e) : { deny: reason }
  }).catch(async ($, e, next) => {
    const rel = relative(e.file_path, await $.session.root())
    return rel === CONFIG || rel === SOUL ? { deny: failedGuard(rel, next.error.kind) } : next(e)
  })

  // Anything that may have written the suite's files redraws the board, and a
  // saved draft is scored at once.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const tool = String(e.tool)
    if (ran.deny !== undefined || !['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'].includes(tool)) {
      return ran
    }
    const path = 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : undefined
    const rel = relative(path ?? '', await $.session.root())
    if (tool !== 'Bash' && !isTracked(rel)) return ran

    const pack = rel === undefined ? undefined : packForPath(rel)
    const touched = pack ? [pack] : rel === CONFIG ? PACKS.filter(one => one.draft.kind !== 'file' && one.draft.kind !== 'latest') : undefined
    const before = await read($, scores)
    const changed = touched ? await scoreAll($, settings, touched) : []
    await refresh($, settings, true)
    for (const score of changed) {
      const def = packById(score.pack)
      const was = before[score.pack]
      const isNews = was === undefined || was.status !== score.status || was.score !== score.score ||
        (was.voice?.length ?? 0) !== (score.voice?.length ?? 0)
      if (def && score.status !== 'missing' && isNews) $.ui.toast(savedToast(def, score))
    }
    return ran
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const found = await read($, board)
    if (found === null || !found.hasProject) return composed

    const all = await read($, scores)
    const failing = PACKS.flatMap(pack => {
      const score = all[pack.id]
      if (score === undefined) return []
      const fix = score.fixes[0] ?? score.reasons[0]
      const voice = score.voice?.length ? `; uses refused phrases: ${score.voice.join(', ')}` : ''
      if (score.status === 'fail') return [`- ${pack.name} (${pack.draft.kind === 'file' ? pack.draft.path : pack.command}): ${scoreLabel(score)}${fix ? `; first fix: ${fix}` : ''}${voice}`]
      return voice ? [`- ${pack.name}: ${scoreLabel(score)}${voice}`] : []
    })
    const text = '# GTM operator suite state (from the gtm-operator mod)\n' +
      'This project uses the GTM operator skill packs. brand-config.json and SOUL.md are shared: ' +
      'merge field by field, never rewrite them, and ask before changing a filled value. ' +
      'Drafts live in gtm/, one file per pack.\n' + summary(found) +
      (failing.length > 0 ? `\nDrafts that fail their pack's scorer:\n${failing.join('\n')}` : '')

    return {
      sections: [...composed.sections, { id: 'gtm-operator:state', text, scope: 'session' }],
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const found = await read($, board)
    if (e.props.hasSurvey || found === null || !found.hasProject || (await read($, isBandHidden))) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const theirs = await next(e)
    const step = nextStep(found)
    const count = `GTM ${doneCount(found)}/${found.steps.length}`
    const failing = failingCount(await read($, scores))

    return (
      <Box flexDirection="column">
        {theirs}
        <Box flexDirection="row" gap={1}>
          <Text bold>{count}</Text>
          {failing > 0 && <Text color="yellow">{`${failing} to fix`}</Text>}
          {step === undefined
            ? <Text dimColor>every step in place</Text>
            : <Text>Next: <Text bold>{step.command}</Text><Text dimColor> — {step.why}</Text></Text>}
          {step !== undefined && (
            <Button
              key="use"
              label="Use"
              variant="primary"
              onPress={() => $.prompt.fill({ text: step.command })}
            />
          )}
          <Button key="board" label="Board" onPress={() => $.ui.open({ id: PANE, title: 'GTM board' })} />
          <Button key="hide" label="Hide" onPress={() => setBandHidden($, true)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const found = await read($, board)
    const width = Math.max(24, e.props.bodyColumns ?? e.viewport?.columns ?? 60)

    if (found === null || !found.hasProject) {
      return (
        <Box flexDirection="column">
          <Text>No GTM project here yet.</Text>
          <Text dimColor>Run /gtm:setup to answer the shared questions once.</Text>
        </Box>
      )
    }

    const all = await read($, scores)
    const past = await read($, history)
    const current = await read($, tab)
    const tabs = (
      <Box flexDirection="row" gap={2}>
        <Button key="tab-board" label="Board" hotkey="1" plain onPress={() => update($, tab, () => 'board' as Tab)} />
        <Button key="tab-detail" label="Detail" hotkey="2" plain onPress={() => update($, tab, () => 'detail' as Tab)} />
      </Box>
    )

    if (current === 'detail') {
      const id = await read($, selected)
      const pack = packById(id) ?? PACKS[0]!
      const score = all[pack.id]
      const samples = past[pack.id] ?? []
      const change = trend(samples)
      const index = PACKS.indexOf(pack)
      const prev = PACKS[(index + PACKS.length - 1) % PACKS.length]!
      const nextPack = PACKS[(index + 1) % PACKS.length]!
      const items = score === undefined ? [] : score.fixes.length > 0 ? score.fixes : score.reasons

      return (
        <Box flexDirection="column">
          {tabs}
          <Text> </Text>
          <Text bold>{cut(`${pack.step}. ${pack.name}  ${scoreLabel(score) || 'not scored'}`, width)}</Text>
          {score?.verdict && <Text dimColor>{cut(score.verdict, width)}</Text>}
          {samples.length > 1 && (
            <Text>{cut(`Trend ${sparkline(samples, Math.min(24, width - 16))}${change !== undefined ? ` ${change >= 0 ? '+' : ''}${change}` : ''}`, width)}</Text>
          )}
          {score?.status === 'missing' && <Text dimColor>{cut(`No draft yet. Run ${pack.command}.`, width)}</Text>}
          {score?.status === 'unknown' && <Text color="yellow">{cut(score.detail ?? 'Not scored.', width)}</Text>}
          {(score?.axes.length ?? 0) > 0 && <Text> </Text>}
          {score?.axes.map(axis => (
            <Text>{cut(`${axis.name.padEnd(12)} ${bar(axis.score, axis.max, 10)} ${axis.score}/${axis.max}`, width)}</Text>
          ))}
          {items.length > 0 && <Text> </Text>}
          {items.length > 0 && <Text bold>{score?.fixes.length ? 'Fixes' : 'Reasons'}</Text>}
          {items.slice(0, 8).map(line => <Text>{cut(`- ${line}`, width)}</Text>)}
          {(score?.voice?.length ?? 0) > 0 && (
            <Text color="yellow">{cut(`Refused phrases from SOUL.md: ${score?.voice?.join(', ')}`, width)}</Text>
          )}
          {score?.excerpt && <Text> </Text>}
          {score?.excerpt && <Text dimColor>{cut(score.excerpt.replace(/\s+/g, ' '), width * 3)}</Text>}
          <Text> </Text>
          <Box flexDirection="row" gap={1}>
            <Button key="prev" label={`← ${prev.name}`} onPress={() => update($, selected, () => prev.id)} />
            <Button key="next-pack" label={`${nextPack.name} →`} onPress={() => update($, selected, () => nextPack.id)} />
          </Box>
          <Box flexDirection="row" gap={1}>
            {score !== undefined && (score.status === 'fail' || (score.voice?.length ?? 0) > 0) && (
              <Button
                key="fix"
                label="Fix with Claude"
                variant="primary"
                onPress={() => $.prompt.fill({
                  text: fixPrompt(pack.command, {
                    ...score,
                    fixes: [...score.fixes, ...(score.voice ?? []).map(one => `remove the refused phrase "${one}"`)],
                  }),
                })}
              />
            )}
            {score?.status === 'missing' && (
              <Button key="run" label={`Fill ${pack.command}`} variant="primary" onPress={() => $.prompt.fill({ text: pack.command })} />
            )}
            <Button key="rescore" label="Rescore" onPress={() => scoreAll($, settings, [pack], true)} />
          </Box>
        </Box>
      )
    }

    const step = nextStep(found)
    const facts: [string, string][] = [
      ['Operator', found.operator],
      ['Buyer', found.segment],
      ['Pain', found.pain],
      ['Value line', found.valueLine],
    ]

    return (
      <Box flexDirection="column">
        {tabs}
        <Text> </Text>
        <Text bold>
          {doneCount(found)}/{found.steps.length} steps in place
        </Text>
        {facts.map(([label, value]) => (
          <Text dimColor={value === ''}>
            {cut(`${label}: ${value === '' ? '—' : value}`, width)}
          </Text>
        ))}
        <Text> </Text>
        {found.steps.map(one => {
          const pack = PACKS.find(def => def.step === one.n)
          const score = pack ? all[pack.id] : undefined
          const label = score && score.status !== 'missing' ? scoreLabel(score) : ''
          const spark = pack ? sparkline(past[pack.id] ?? [], 8) : ''
          const mark = score?.status === 'fail' ? '✗' : one.isDone ? '✓' : one === step ? '▸' : '·'
          const tail = label !== '' ? `${label}${spark.length > 1 ? ` ${spark}` : ''}` : one.isDone ? one.check : one.command
          const line = cut(`${mark} ${one.n}. ${one.name}  ${tail}`, width)
          return pack ? (
            <Button
              key={`step-${pack.id}`}
              label={line}
              plain
              onPress={() => openDetail($, pack.id)}
            />
          ) : (
            <Text bold={one === step} dimColor={one.isDone}>{line}</Text>
          )
        })}
        <Text> </Text>
        {step !== undefined && (
          <Text>
            {cut(`Next: ${step.command} — ${step.why}`, width)}
          </Text>
        )}
        {step !== undefined && (
          <Text dimColor>
            {cut(`Not installed? /plugin install ${INSTALL_NAMES[step.command] ?? 'gtm'}@gtm-operator-skills`, width)}
          </Text>
        )}
        <Box flexDirection="row" gap={1}>
          {step !== undefined && (
            <Button
              key="fill"
              label="Fill next"
              variant="primary"
              onPress={() => $.prompt.fill({ text: step.command })}
            />
          )}
          <Button key="refresh" label="Rescore all" onPress={() => scoreAll($, settings, undefined, true)} />
          <Button key="band" label="Show band" onPress={() => setBandHidden($, false)} />
        </Box>
      </Box>
    )
  })
}
