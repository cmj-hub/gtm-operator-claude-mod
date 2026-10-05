import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Finding, GtmBoard, History, Outcome, PackId, Score, Scores, Tab, ToolRuns, ViewId } from '../types'
import { addOutcome, allStats, digest, duration, importOutcomes, outcomesByVersion, outcomesKey, parseOutcomeCsv, sprintStep } from './analytics'
import { allFindings, hashOf } from './drift'
import type { DraftFile, Snapshot, Upstream } from './drift'
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
import { fixPrompt, gateLines, normalize, scoreLabel } from './score'
import { draftExcerpt, draftText, refusedPhrases, voiceHits } from './voice'
import { coldEmailView, evpLadder, founderView, geoView, leakLabel, money, pricingView, prospectBoard, shareBar } from './views'

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
const findings = atom({ plugin: 'gtm-operator', key: 'findings' } as const, [])
const view = atom({ plugin: 'gtm-operator', key: 'view' } as const, 'pricing')
const toolRuns = atom({ plugin: 'gtm-operator', key: 'toolRuns' } as const, {})
const sprint = atom({ plugin: 'gtm-operator', key: 'sprint' } as const, null)
const outcomes = atom({ plugin: 'gtm-operator', key: 'outcomes' } as const, [])

const TOOL_PREFIX = 'mcp__gtm-operator__'

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
  return { ...scored, ...(voice.length > 0 ? { voice } : {}), excerpt: draftExcerpt(draft.text).slice(0, 600) }
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

// --- Cross-pack checks ------------------------------------------------------

type BlockTimes = Partial<Record<Upstream, { hash: string; at: number }>>

const UPSTREAM_FIELDS: Record<Upstream, string> = { psp: 'psp', evp: 'evp', price: 'pricing' }

/** Notes when the PSP, EVP and pricing blocks change; the first sighting counts as unknown (0). */
async function blockTimes($: $, root: string, config: Record<string, unknown>): Promise<Partial<Record<Upstream, number>>> {
  const key = `blocks:${root}`
  const saved = ((await $.store.get(key)) ?? {}) as BlockTimes
  const now = await $.clock.now()
  const next: BlockTimes = {}
  const times: Partial<Record<Upstream, number>> = {}
  for (const up of Object.keys(UPSTREAM_FIELDS) as Upstream[]) {
    const hash = hashOf(field(config as never, UPSTREAM_FIELDS[up]))
    const was = saved[up]
    const at = was === undefined ? 0 : was.hash === hash ? was.at : now
    next[up] = { hash, at }
    times[up] = at
  }
  if (JSON.stringify(next) !== JSON.stringify(saved)) await $.store.set(key, next)
  return times
}

async function snapshot($: $): Promise<Snapshot> {
  const root = await projectRoot($)
  const config = parseConfig(await readText($, `${root}/${CONFIG}`).catch(() => undefined)) ?? {}
  const drafts: Partial<Record<PackId, DraftFile>> = {}
  for (const pack of PACKS) {
    if (pack.draft.kind !== 'file') continue
    const path = `${root}/${pack.draft.path}`
    const stat = await $.fs.stat(path).catch(() => undefined)
    if (stat?.kind !== 'file') continue
    drafts[pack.id] = { text: (await $.fs.read(path).catch(() => '')) as string, mtimeMs: stat.mtimeMs }
  }
  const changedAt = await blockTimes($, root, config)
  const priceFile = drafts.price?.mtimeMs ?? 0
  return { config, drafts, changedAt: { ...changedAt, price: Math.max(changedAt.price ?? 0, priceFile) } }
}

async function checkDrift($: $): Promise<Finding[]> {
  const found = allFindings(await snapshot($))
  await update($, findings, () => found)
  return found
}

// --- Extra pack tools behind the views -------------------------------------

/** A tool script next to a pack's scorer (same install), or undefined. */
async function toolPath($: $, settings: Settings, pack: PackDef, rel: string): Promise<string | undefined> {
  if (scorerPaths.size === 0) await locateScorers($, settings)
  const scorer = scorerPaths.get(pack.id)
  if (!scorer) return undefined
  const fileName = rel.slice(rel.lastIndexOf('/') + 1)
  const candidates = scorer.endsWith(pack.scorer)
    ? [`${scorer.slice(0, -pack.scorer.length)}${rel}`]
    : [`${scorer.slice(0, scorer.lastIndexOf('/'))}/${fileName}`]
  for (const path of candidates) if (await $.fs.exists(path).catch(() => false)) return path
  return undefined
}

async function runTool($: $, settings: Settings, name: string, packId: PackId, rel: string, args: string[]): Promise<void> {
  const pack = packById(packId)
  if (pack === undefined || !settings.runScorers) return
  const path = await toolPath($, settings, pack, rel)
  const at = await $.clock.now()
  const ran = path === undefined
    ? { exitCode: -1, stdout: '', stderr: `${rel} not found next to ${pack.repo}'s scorer` }
    : await $.process.run([settings.python, path, ...args, '--json'], { timeoutMs: SCORER_TIMEOUT_MS })
      .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: String(error) }))
  await update($, toolRuns, all => ({ ...all, [name]: { at, exitCode: ran.exitCode, stdout: ran.stdout, stderr: ran.stderr } }))
}

/** Runs what a view needs, then shows it. The deliverability check only runs when asked. */
async function loadView($: $, settings: Settings, id: ViewId, isDeliverability = false): Promise<void> {
  const root = await projectRoot($)
  const has = (rel: string) => $.fs.exists(`${root}/${rel}`).catch(() => false)
  if (id === 'pricing') {
    if (await has('gtm/waterfall.csv')) await runTool($, settings, 'waterfall', 'price', 'scripts/pocket_price_waterfall.py', ['--file', `${root}/gtm/waterfall.csv`])
    if (await has('gtm/tiers.json')) await runTool($, settings, 'decoy', 'price', 'scripts/decoy_validator.py', ['--file', `${root}/gtm/tiers.json`])
  }
  if (id === 'cold-email') {
    if (await has('gtm/letter.json')) {
      await runTool($, settings, 'spam', 'letter', 'scripts/spam_word_lint.py', ['--file', `${root}/gtm/letter.json`])
      await runTool($, settings, 'subject', 'letter', 'scripts/score_subject_line.py', ['--file', `${root}/gtm/letter.json`])
    }
    if (await has('gtm/replies.jsonl')) await runTool($, settings, 'replies', 'letter', 'scripts/score_reply.py', ['--file', `${root}/gtm/replies.jsonl`])
    if (isDeliverability) {
      const config = parseConfig(await readText($, `${root}/${CONFIG}`).catch(() => undefined)) ?? {}
      const domain = coldEmailView({ letter: undefined, config, now: 0 }).domain
      if (domain !== '') await runTool($, settings, 'deliverability', 'letter', 'scripts/check_deliverability.py', ['--domain', domain])
    }
  }
  await update($, view, () => id)
  await update($, tab, () => 'views')
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
  const warnings = found.hasProject && lastFindings > 0 ? ` · ${lastFindings} warning${lastFindings === 1 ? '' : 's'}` : ''
  return `GTM ${doneCount(found)}/${found.steps.length}${fixes}${warnings} · ${tail}`
}

let lastFindings = 0

async function refresh($: $, settings: Settings, isAnnounced = false): Promise<GtmBoard> {
  const found = await scan($)
  const before = await read($, board)
  await update($, board, () => found)
  if (found.hasProject) {
    await scoreAll($, settings)
    lastFindings = (await checkDrift($)).length
  }
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
  const log = await $.store.get(outcomesKey(root))
  await update($, outcomes, () => (Array.isArray(log) ? (log as Outcome[]) : []))
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
  const fixes = gateLines(score).map(one => `- ${one}`).join('\n')
  return `gtm-operator: this ${pack.name} draft scores ${score.score ?? score.status} with ${pack.repo}'s scorer, ` +
    `below the minimum of ${settings.minScore} set for this project. Fix these, then write it again:\n${fixes}`
}

// --- Actions, the sprint, analytics ----------------------------------------

/**
 * Runs a pack's slash command as if typed. Deferred to a timer: a command.run
 * hook cannot start a turn while it holds one, and a slash command can only
 * go through $.command.run, never $.prompt.submit.
 */
function runNext($: $, command: string): void {
  const [name = '', ...rest] = command.replace(/^\//, '').split(' ')
  $.clock.after(1, () => {
    $.command.run({ command: name, args: rest.join(' ') }).catch(() => undefined)
  })
}

/**
 * How a sprint step starts: 'run' from a press or turn.complete, 'fill' (the
 * prompt, for the person to send) from a slash command, which may not start a turn.
 */
type Launch = 'run' | 'fill'

// False in a -p run or the SDK: no prompt to fill, so the command is named instead.
let isInteractive = true

async function launch($: $, how: Launch, command: string): Promise<void> {
  if (how === 'run') runNext($, command)
  else if (isInteractive) await $.prompt.fill({ text: command })
}

/** What a 'fill' launch tells the person to do with the command. */
function handoff(command: string, verb: string): string {
  return isInteractive ? `${command} is in your prompt; send it to ${verb}` : `run ${command} to ${verb}`
}

/** Starts a sprint at the next open step, running through `target`. */
async function startSprint($: $, settings: Settings, target: number, how: Launch): Promise<string> {
  const found = await refresh($, settings)
  const step = nextStep(found)
  if (step === undefined) return 'Every step is in place; nothing to sprint through.'
  if (step.n === 0) return 'Run /gtm:setup first; the sprint starts at the PSP.'
  const pack = PACKS.find(one => one.step === step.n)
  if (pack === undefined || step.n > target) return `The next step (${step.n}) is past the sprint's end (${target}).`
  const startedAt = await $.clock.now()
  await update($, sprint, () => ({ current: pack.id, target, startedAt }))
  await launch($, how, pack.command)
  const first = how === 'fill' ? handoff(pack.command, 'start') : `${pack.name} now`
  return `Sprint started: ${first}, then each pack through step ${target}. A pack only runs once the one before it passes its scorer. /gtm-sprint stop ends it.`
}

/** After each main-thread turn of a sprint: score the step and go on, finish, or pause. */
async function afterSprintTurn($: $, settings: Settings, how: Launch = 'run'): Promise<void> {
  const active = await read($, sprint)
  if (active === null || active.paused !== undefined) return
  const current = packById(active.current)
  if (current === undefined) return
  await scoreAll($, settings, [current], true)
  const verdict = sprintStep(active.current, active.target, await read($, scores))
  if (verdict.kind === 'advance') {
    const next = packById(verdict.next)
    if (next === undefined) return
    await update($, sprint, () => ({ ...active, current: next.id }))
    $.ui.toast(`GTM sprint: ${current.name} passes. Next: ${next.command}`)
    await launch($, how, next.command)
  } else if (verdict.kind === 'done') {
    await update($, sprint, () => null)
    $.ui.toast(`GTM sprint done through step ${active.target}.`)
  } else {
    await update($, sprint, () => ({ ...active, paused: verdict.reason }))
    $.ui.toast(`GTM sprint paused: ${verdict.reason}. Fix it, then /gtm-sprint resume.`)
  }
}

/** What gtm_score answers: the label, then the scorer's reasons and fixes. */
function scoreReport(head: string, score: Score | undefined): string {
  return [
    `${head}: ${score ? scoreLabel(score) || score.status : 'not scored'}`,
    ...(score?.detail ? [score.detail] : []),
    ...(score?.reasons ?? []).map(one => `reason: ${one}`),
    ...(score?.fixes ?? []).map(one => `fix: ${one}`),
    ...(score?.voice ?? []).map(one => `refused phrase from SOUL.md: ${one}`),
  ].join('\n')
}

const countOf = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

async function logOutcome($: $, kind: Outcome['kind'], value: string): Promise<void> {
  const root = await projectRoot($)
  const letter = await readText($, `${root}/gtm/letter.json`).catch(() => undefined)
  const letterScore = (await read($, scores)).letter
  const entry: Outcome = {
    at: await $.clock.now(),
    kind,
    count: Number(value.trim()),
    version: letter === undefined ? 'no letter' : hashOf(letter).slice(0, 6),
    ...(letterScore?.score !== undefined ? { score: letterScore.score } : {}),
  }
  const next = addOutcome(await read($, outcomes), entry)
  if (next === undefined) {
    $.ui.toast('GTM: enter a whole number, like 3.')
    return
  }
  await update($, outcomes, () => next)
  await $.store.set(outcomesKey(root), next)
}

async function weeklyDigest($: $): Promise<string> {
  const found = await read($, board)
  return digest({
    now: await $.clock.now(),
    history: await read($, history),
    scores: await read($, scores),
    findings: await read($, findings),
    outcomes: await read($, outcomes),
    ...(found && nextStep(found) ? { nextCommand: nextStep(found)?.command } : {}),
  })
}

/** What the gtm_status tool and /gtm-board report, as text. */
async function statusText($: $): Promise<string> {
  const found = await read($, board)
  if (found === null || !found.hasProject) return 'No GTM project here: no brand-config.json and no gtm/ folder. Run /gtm:setup.'
  const all = await read($, scores)
  const lines = PACKS.map(pack => {
    const score = all[pack.id]
    return `${pack.step}. ${pack.name} (${pack.command}): ${score ? scoreLabel(score) || score.status : 'not scored'}`
  })
  return `${summary(found)}\n${lines.join('\n')}`
}

// --- Drawing ---------------------------------------------------------------

function bar(value: number, max: number, width: number): string {
  const filled = max > 0 ? Math.round((value / max) * width) : 0
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`
}

type RenderEvent = Parameters<EngineInterface['ui']['resolve']>[0]

async function draftFile($: $, rel: string): Promise<DraftFile | undefined> {
  const path = `${await projectRoot($)}/${rel}`
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat?.kind !== 'file') return undefined
  return { text: (await $.fs.read(path).catch(() => '')) as string, mtimeMs: stat.mtimeMs }
}

/** One pack view, drawn from the pack's files and its tools' last output. */
async function drawView($: $, e: RenderEvent, settings: Settings, id: ViewId, width: number) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const runs = await read($, toolRuns)
  const root = await projectRoot($)
  const config = parseConfig(await readText($, `${root}/${CONFIG}`).catch(() => undefined)) ?? {}
  const now = await $.clock.now()
  const line = (text: string, props: { bold?: boolean; dimColor?: boolean; color?: string } = {}) =>
    <Text {...props}>{cut(text, width)}</Text>
  const empty = (text: string) => <Box flexDirection="column">{line(text, { dimColor: true })}</Box>

  if (id === 'pricing') {
    const priceView = pricingView(runs.waterfall?.stdout, runs.decoy?.stdout, await draftFile($, 'gtm/price.json'))
    if (priceView.customers.length === 0 && priceView.checks.length === 0 && priceView.contrastSet.length === 0) {
      return empty('No pricing data yet. /pricing:pricing writes gtm/price.json; the waterfall reads gtm/waterfall.csv, the decoy check gtm/tiers.json.')
    }
    const barWidth = Math.max(8, Math.min(30, width - 40))
    return (
      <Box flexDirection="column">
        {priceView.valueMetric !== '' && line(`Value metric: ${priceView.valueMetric}`)}
        {priceView.contrastSet.length > 0 && line(`Contrast set: ${priceView.contrastSet.join(' · ')}`)}
        {priceView.customers.length > 0 && <Text> </Text>}
        {priceView.customers.length > 0 && line(`Pocket-price waterfall: ${money(priceView.totalPocket)} kept of ${money(priceView.totalList)} list`, { bold: true })}
        {priceView.customers.map(one => line(`${one.id.padEnd(10)} ${shareBar(one.pocket, Math.max(one.list, one.pocket), barWidth)} ${money(one.pocket)} of ${money(one.list)} (${leakLabel(one.leakPct)})`))}
        {priceView.byStep.length > 0 && line(`Biggest leaks: ${priceView.byStep.slice(0, 3).map(step => `${step.name} ${money(step.leak)}`).join(', ')}`, { color: 'yellow' })}
        {priceView.checks.length > 0 && <Text> </Text>}
        {priceView.checks.length > 0 && line(`Tier contrast check${priceView.tiersScore !== undefined ? `: ${priceView.tiersScore}/100` : ''}`, { bold: true })}
        {priceView.checks.map(check => line(`${check.passed ? '✓' : '✗'} ${check.rule}: ${check.detail}`, check.passed ? { dimColor: true } : { color: 'yellow' }))}
      </Box>
    )
  }

  if (id === 'prospects') {
    const board = prospectBoard(await draftFile($, 'gtm/list.json'))
    const total = board.call.length + board.hold.length + board.drop.length + board.unscored.length
    if (total === 0) return empty('No prospects yet. Run /prospect-list:who-to-contact.')
    const column = (title: string, items: { title: string; signal: string }[], color?: string) => (
      <Box flexDirection="column">
        {line(`${title} (${items.length})`, { bold: true, ...(color ? { color } : {}) })}
        {items.slice(0, 8).map(one => line(`  ${one.title}${one.signal ? ` — ${one.signal}` : ''}`))}
        {items.length > 8 && line(`  +${items.length - 8} more`, { dimColor: true })}
      </Box>
    )
    return (
      <Box flexDirection="column">
        {column('Call this week', board.call, 'green')}
        {column('Hold', board.hold)}
        {column('Drop', board.drop, 'gray')}
        {board.unscored.length > 0 && column('Not scored', board.unscored, 'yellow')}
      </Box>
    )
  }

  if (id === 'cold-email') {
    const mail = coldEmailView({
      letter: await draftFile($, 'gtm/letter.json'),
      config,
      ...(runs.spam ? { spam: runs.spam.stdout } : {}),
      ...(runs.subject ? { subject: runs.subject.stdout } : {}),
      ...(runs.replies ? { replies: runs.replies.stdout } : {}),
      ...(runs.deliverability ? { deliverability: runs.deliverability } : {}),
      now,
    })
    const replyKinds = Object.entries(mail.replies)
    return (
      <Box flexDirection="column">
        {mail.words === 0 ? line('No first touch yet. Run /cold-email:cold-email.', { dimColor: true }) : line(`First touch: ${mail.words} words${mail.subject ? ` · subject "${mail.subject}"` : ''}`, { bold: true })}
        {mail.signal !== '' && line(`Signal: ${mail.signal}`)}
        {mail.spamScore !== undefined && line(`Spam lint: ${mail.spamScore}/100 ${mail.spamVerdict}`, mail.spamScore >= 75 ? {} : { color: 'yellow' })}
        {mail.subjectScore !== undefined && line(`Subject line: ${mail.subjectScore}/100`, mail.subjectScore >= 70 ? {} : { color: 'yellow' })}
        <Text> </Text>
        {line(`Rhythm: ${mail.rhythm.map(day => (day.isSendDay ? (day.isToday ? `[${day.day}]` : day.day) : day.isToday ? `(${day.day.toLowerCase()})` : '·')).join(' ')}`)}
        {replyKinds.length > 0 && line(`Replies: ${replyKinds.map(([kind, count]) => `${kind} ${count}`).join(' · ')}`)}
        <Text> </Text>
        {line(`Deliverability${mail.domain ? ` for ${mail.domain}` : ''}`, { bold: true })}
        {mail.domain === '' && line('No sending domain in brand-config.infrastructure. /cold-email:cold-email setup asks for it.', { dimColor: true })}
        {mail.deliverability?.lines.slice(0, 15).map(one => line(one, one.startsWith('✗') ? { color: 'yellow' } : {}))}
        {mail.domain !== '' && (
          <Button key="deliverability" label="Check deliverability (DNS, needs dig)" onPress={() => loadView($, settings, 'cold-email', true)} />
        )}
      </Box>
    )
  }

  if (id === 'evp') {
    const ladder = evpLadder(config)
    if (ladder.primary === '' && ladder.rungs.every(rung => rung.lines.length === 0)) return empty('No value line yet. Run /evp:evp.')
    return (
      <Box flexDirection="column">
        {line('Awareness ladder (Schwartz): one line per reader', { bold: true })}
        {ladder.rungs.map(rung => (
          <Box flexDirection="column">
            {line(`${rung.isChosen ? '▸' : ' '} ${rung.tier}. ${rung.name}${rung.isChosen ? '  (outreach line)' : ''}`, rung.isChosen ? { bold: true, color: 'cyan' } : { dimColor: rung.lines.length === 0 })}
            {rung.lines.slice(0, 2).map(text => line(`    ${text}`))}
          </Box>
        ))}
      </Box>
    )
  }

  if (id === 'geo') {
    const geo = geoView(await draftFile($, 'gtm/findability.json'), now)
    if (geo === undefined) return empty('No findability record yet. Run /geo:geo.')
    return (
      <Box flexDirection="column">
        {geo.question !== '' && line(`Buyer question: ${geo.question}`, { bold: true })}
        {geo.killDate !== '' && line(`Kill date ${geo.killDate}${geo.daysLeft !== undefined ? ` · ${geo.daysLeft >= 0 ? `${geo.daysLeft} days left` : `${-geo.daysLeft} days past: review now (/geo:geo review)`}` : ''}`, geo.daysLeft !== undefined && geo.daysLeft < 0 ? { color: 'yellow' } : {})}
        {geo.isIndexable !== undefined && line(`Indexable: ${geo.isIndexable ? 'yes' : 'no'}`, geo.isIndexable ? {} : { color: 'yellow' })}
        {geo.blockedBots.length > 0 && line(`Blocked crawlers: ${geo.blockedBots.join(', ')}`, { color: 'yellow' })}
        {geo.engines.length > 0 && <Text> </Text>}
        {geo.engines.length > 0 && line('Citations by engine', { bold: true })}
        {geo.engines.map(one => line(`${one.engine.padEnd(22)} brand ${one.status || 'unknown'} · ${one.cited} cited URL${one.cited === 1 ? '' : 's'}`))}
      </Box>
    )
  }

  const entries = await $.fs.list(`${root}/drafts`).catch(() => [])
  const founder = founderView(entries.filter(one => one.kind === 'file'), now)
  return (
    <Box flexDirection="column">
      {line(founder.daysSinceLast === undefined ? 'No posts in drafts/ yet. Run /founder-brand:founder-brand.' : `Last post ${founder.daysSinceLast} day${founder.daysSinceLast === 1 ? '' : 's'} ago · ${founder.postsLast28} in the last 28 days`, founder.isLate ? { color: 'yellow', bold: true } : { bold: true })}
      {founder.isLate && founder.daysSinceLast !== undefined && line('Over 7 days since the last post: the rotation has stalled.', { color: 'yellow' })}
      <Text> </Text>
      {founder.pillars.map(one => line(`${one.pillar.padEnd(8)} ${one.count} post${one.count === 1 ? '' : 's'}${one.lastDaysAgo !== undefined ? ` · last ${one.lastDaysAgo}d ago` : ' · none yet'}`, one.count === 0 ? { dimColor: true } : {}))}
    </Box>
  )
}

export const register: Register = (on, options) => {
  const settings = settingsFrom(options)

  on('session.start', async ($, e, next) => {
    isInteractive = e.isInteractive
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
      name: 'gtm-health',
      description: 'Cross-pack checks: stale drafts, drafts that disagree, buyers the list leaves out',
      immediate: true,
    })
    await $.command.register({
      name: 'gtm-guard',
      description: 'Turn the brand-config.json / SOUL.md overwrite guard on or off',
      argumentHint: '[on|off]',
      immediate: true,
    })
    await $.command.register({
      name: 'gtm-sprint',
      description: 'Run the GTM packs in order, each only after the one before passes its scorer',
      argumentHint: '[to <step>|stop|resume]',
    })
    await $.command.register({
      name: 'gtm-digest',
      description: 'The GTM weekly digest: what moved, what needs work, outcomes',
      immediate: true,
    })
    await $.command.register({
      name: 'gtm-outcomes',
      description: 'GTM outcome log: replies and meetings per cold email version; import <file.csv> reads date, replies, meetings',
      argumentHint: '[import <file.csv>]',
      immediate: true,
    })
    await $.tool.register({
      name: 'gtm_status',
      description: 'GTM operator suite status for this project: which steps are done, the next pack command, and each draft\'s score from its pack\'s own scorer. Call before choosing which GTM pack to run.',
    })
    await $.tool.register({
      name: 'gtm_score',
      description: 'Score one GTM draft now with its pack\'s own scorer and return the score, reasons and fixes. Give pack, or file to score a given draft. Call after writing or editing a draft in gtm/, drafts/ or the psp/evp blocks of brand-config.json, before saying it is done.',
      inputSchema: {
        type: 'object',
        properties: {
          pack: { type: 'string', description: `One of: ${PACKS.map(pack => pack.plugin).join(', ')}` },
          file: { type: 'string', description: 'A draft path from the project root (gtm/letter.json, drafts/2026-10-05-post.md). Scores that file; the pack follows from the path.' },
        },
      },
    })
    await $.tool.register({
      name: 'gtm_consistency',
      description: 'Cross-pack checks for the GTM suite: drafts gone stale after a PSP/EVP/price change, a page that does not lead with the EVP or name the tiers, drafts missing the buyer\'s words, roles the prospect list leaves out. Heuristics; confirm before acting.',
    })
    await $.agent.register({
      name: 'reviewer',
      description: 'Reviews one GTM draft (gtm/*.json, drafts/*.md, or the psp/evp blocks) against the PSP, the EVP, SOUL.md and its pack\'s scorer, and returns what to change. Read-only.',
      prompt: [
        'You review one go-to-market draft for an operator using the GTM operator skill packs. You do not edit files.',
        'Read brand-config.json (the psp and evp blocks, icp, tone) and SOUL.md (voice; "Phrases I refuse" are banned).',
        `Call ${TOOL_PREFIX}gtm_score for the draft's pack and ${TOOL_PREFIX}gtm_consistency.`,
        'Then check what a scorer cannot: is it in the buyer\'s words from psp.vocabulary, does it lead with the EVP line, is every claim backed by a receipt the operator gave, would the buyer named in the PSP stop on the first line?',
        'Answer with: the score line, then at most five changes, most important first, each as "what is wrong -> what to write instead". Quote the draft. No praise, no summary.',
      ].join('\n'),
      tools: ['Read', 'Glob', 'Grep', `${TOOL_PREFIX}gtm_score`, `${TOOL_PREFIX}gtm_status`, `${TOOL_PREFIX}gtm_consistency`],
      model: 'inherit',
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

  on('command.run', { command: 'gtm-health' }, async $ => {
    await refresh($, settings)
    const found = await read($, findings)
    if (found.length === 0) return { text: 'No cross-pack issues: no stale drafts, no disagreements, no missing buyers.' }
    await update($, tab, () => 'health')
    return { text: found.map(one => `- [${one.kind}] ${one.message}`).join('\n') }
  })

  on('command.run', { command: 'gtm-sprint' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const active = await read($, sprint)
    if (arg === 'stop') {
      await update($, sprint, () => null)
      return { text: active ? 'GTM sprint stopped.' : 'No GTM sprint is running.' }
    }
    if (arg === 'resume') {
      if (active === null) return { text: 'No GTM sprint to resume. Start one with /gtm-sprint.' }
      await update($, sprint, () => ({ current: active.current, target: active.target, startedAt: active.startedAt }))
      await afterSprintTurn($, settings, 'fill')
      const now = await read($, sprint)
      if (now === null) return { text: 'GTM sprint done.' }
      return { text: now.paused ? `Still paused: ${now.paused}.` : `GTM sprint resumed: ${handoff(packById(now.current)?.command ?? '', 'go on')}.` }
    }
    const match = /^(?:to\s+)?(\d+)$/.exec(arg)
    const target = match ? Math.min(10, Math.max(1, Number(match[1]))) : 10
    return { text: await startSprint($, settings, target, 'fill') }
  })

  on('command.run', { command: 'gtm-digest' }, async ($, e) => {
    await refresh($, settings)
    return { text: await weeklyDigest($) }
  })

  on('command.run', { command: 'gtm-outcomes' }, async ($, e) => {
    const root = await projectRoot($)
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    if (verb === 'import') {
      const rel = rest.join(' ').replace(/^\.\//, '')
      if (rel === '' || rel.startsWith('/') || rel.split(/[\\/]/).includes('..')) {
        return { text: 'Give a path inside the project, like crm/outcomes.csv.' }
      }
      const text = await readText($, `${root}/${rel}`).catch(() => undefined)
      if (text === undefined) return { text: `No file at ${rel} (paths are from the project root).` }
      const parsed = parseOutcomeCsv(text)
      const next = importOutcomes(await read($, outcomes), parsed.rows)
      await update($, outcomes, () => next)
      await $.store.set(outcomesKey(root), next)
      const skipped = parsed.errors.length > 0 ? ` Skipped: ${parsed.errors.join('; ')}.` : ''
      return { text: `Imported ${parsed.rows.length} outcome row${parsed.rows.length === 1 ? '' : 's'} from ${rel}.${skipped}` }
    }
    const rows = outcomesByVersion(await read($, outcomes))
    if (rows.length === 0) return { text: 'No outcomes logged. Log them on the board\'s Analytics tab, or /gtm-outcomes import <file.csv> (columns: date, replies, meetings).' }
    return {
      text: rows.map(row => `${row.version}: ${countOf(row.replies, 'reply', 'replies')} · ${countOf(row.meetings, 'meeting', 'meetings')}${row.score !== undefined ? ` · letter scored ${row.score}` : ''}`).join('\n'),
    }
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

  on('tool.call', { tool: 'mcp__gtm-operator__gtm_status' }, async $ => {
    await refresh($, settings)
    const text = await statusText($)
    return { result: text, text }
  })

  on('tool.call', { tool: 'mcp__gtm-operator__gtm_score' }, async ($, e) => {
    const file = 'file' in e && typeof e.file === 'string' ? e.file.trim() : ''
    if (file !== '') {
      const root = await projectRoot($)
      const rel = relative(file, root)
      const filePack = rel === undefined ? undefined : packForPath(rel)
      if (rel === undefined || filePack === undefined) {
        const text = `${file} is not a GTM draft: give a gtm/*.json or drafts/*.md path, or a pack (${PACKS.map(one => one.plugin).join(', ')}).`
        return { result: text, text, isError: true }
      }
      const content = await readText($, `${root}/${rel}`).catch(() => undefined)
      if (content === undefined) {
        const text = `No file at ${rel}.`
        return { result: text, text, isError: true }
      }
      if (scorerPaths.size === 0) await locateScorers($, settings)
      const score = await runScorer($, settings, filePack, { stdin: content })
      const text = scoreReport(`${filePack.name} (${filePack.command}), ${rel}`, score)
      return { result: text, text }
    }
    const wanted = 'pack' in e && typeof e.pack === 'string' ? e.pack : ''
    const pack = PACKS.find(one => one.plugin === wanted || one.id === wanted || one.repo === wanted)
    if (pack === undefined) {
      const text = `Unknown pack "${wanted}". Use one of: ${PACKS.map(one => one.plugin).join(', ')}.`
      return { result: text, text, isError: true }
    }
    await scoreAll($, settings, [pack], true)
    const score = (await read($, scores))[pack.id]
    const text = scoreReport(`${pack.name} (${pack.command})`, score)
    return { result: text, text }
  })

  on('tool.call', { tool: 'mcp__gtm-operator__gtm_consistency' }, async $ => {
    await refresh($, settings)
    const found = await read($, findings)
    const text = found.length === 0 ? 'No cross-pack issues found.' : found.map(one => `- [${one.kind}] ${one.message}`).join('\n')
    return { result: text, text }
  })

  // The guided sprint moves on after each main-thread turn.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && !e.isAborted && (await read($, sprint)) !== null) await afterSprintTurn($, settings)
    return done
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
      (failing.length > 0 ? `\nDrafts that fail their pack's scorer:\n${failing.join('\n')}` : '') +
      (await read($, findings)).reduce((out, one, i) => `${out}${i === 0 ? '\nCross-pack warnings (heuristics; confirm before acting):' : ''}\n- ${one.message}`, '')

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
    const warnings = (await read($, findings)).length
    const fixText = failing > 0 ? `${failing} to fix` : ''
    const warnText = warnings > 0 ? `${warnings} warning${warnings === 1 ? '' : 's'}` : ''
    // The reason for the next step goes first when the row is short of room,
    // as it is beside a docked pane: the labels and buttons never wrap.
    const BUTTONS = '[ Use ] [ Run ] [ Board ] [ Hide ]'.length
    const fixed = [count, fixText, warnText].filter(one => one !== '').reduce((n, one) => n + one.length + 1, 0) + BUTTONS + 1
    const showWhy = step !== undefined &&
      fixed + `Next: ${step.command} — ${step.why}`.length <= e.props.bodyColumns

    return (
      <Box flexDirection="column">
        {theirs}
        <Box flexDirection="row" gap={1}>
          <Box flexShrink={0}><Text bold>{count}</Text></Box>
          {fixText !== '' && <Box flexShrink={0}><Text color="yellow">{fixText}</Text></Box>}
          {warnText !== '' && <Box flexShrink={0}><Text color="yellow">{warnText}</Text></Box>}
          {step === undefined
            ? <Text dimColor>every step in place</Text>
            : (
              <Box flexShrink={1}>
                <Text wrap="truncate-end">Next: <Text bold>{step.command}</Text>{showWhy && <Text dimColor> — {step.why}</Text>}</Text>
              </Box>
            )}
          {step !== undefined && (
            <Button
              key="use"
              label="Use"
              variant="primary"
              onPress={() => $.prompt.fill({ text: step.command })}
            />
          )}
          {step !== undefined && <Button key="run" label="Run" onPress={() => runNext($, step.command)} />}
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
    const health = await read($, findings)
    const current_view = await read($, view)
    const tabs = (
      <Box flexDirection="row" gap={2}>
        <Button key="tab-board" label="Board" hotkey="1" plain onPress={() => update($, tab, () => 'board' as Tab)} />
        <Button key="tab-detail" label="Detail" hotkey="2" plain onPress={() => update($, tab, () => 'detail' as Tab)} />
        <Button key="tab-health" label={`Health${health.length > 0 ? ` (${health.length})` : ''}`} hotkey="3" plain onPress={() => update($, tab, () => 'health' as Tab)} />
        <Button key="tab-views" label="Views" hotkey="4" plain onPress={() => loadView($, settings, current_view)} />
        <Button key="tab-analytics" label="Analytics" hotkey="5" plain onPress={() => update($, tab, () => 'analytics' as Tab)} />
      </Box>
    )

    if (current === 'analytics') {
      const elements = $.ui.resolve(e)
      const Input = 'Input' in elements ? elements.Input : undefined
      const stats = allStats(past)
      const log = await read($, outcomes)
      const versions = outcomesByVersion(log)
      const resolved = stats.reduce((sum, one) => sum + one.fixesResolved, 0)
      return (
        <Box flexDirection="column">
          {tabs}
          <Text> </Text>
          <Text bold>{`Score history · ${resolved} fix${resolved === 1 ? '' : 'es'} resolved`}</Text>
          {stats.length === 0 && <Text dimColor>No drafts scored yet.</Text>}
          {stats.map(one => {
            const pack = packById(one.pack)
            const range = one.first !== undefined && one.last !== undefined ? `${one.first}→${one.last}` : `${one.samples} run${one.samples === 1 ? '' : 's'}`
            const pass = one.draftsToPass === undefined ? 'not passing yet'
              : one.draftsToPass === 0 ? 'passed first time'
              : `passed after ${one.draftsToPass} failing draft${one.draftsToPass === 1 ? '' : 's'} (${duration(one.timeToPass ?? 0)})`
            return <Text>{cut(`${(pack?.name ?? one.pack).padEnd(20)} ${sparkline(past[one.pack] ?? [], 10).padEnd(10)} ${range} · ${pass}`, width)}</Text>
          })}
          <Text> </Text>
          <Text bold>Outcomes (log weekly; tied to the live cold email)</Text>
          {versions.length === 0 && <Text dimColor>{cut('Nothing logged. The packs never read your CRM: log replies and meetings here, or /gtm-outcomes import <file.csv>.', width)}</Text>}
          {versions.map(row => (
            <Text>{cut(`${row.version === 'imported' ? 'imported from CSV' : `letter ${row.version}`}${row.score !== undefined ? ` (scored ${row.score})` : ''}: ${countOf(row.replies, 'reply', 'replies')} · ${countOf(row.meetings, 'meeting', 'meetings')}`, width)}</Text>
          ))}
          {Input !== undefined && (
            <Input key="outcome-replies" label="Replies this week" placeholder="a number" value="" submitLabel="log" onSubmit={(value: string) => logOutcome($, 'replies', value)} />
          )}
          {Input !== undefined && (
            <Input key="outcome-meetings" label="Meetings this week" placeholder="a number" value="" submitLabel="log" onSubmit={(value: string) => logOutcome($, 'meetings', value)} />
          )}
          {Input === undefined && <Text dimColor>Log outcomes from the terminal or the Desktop app.</Text>}
          <Text> </Text>
          <Button key="digest" label="Copy weekly digest" onPress={async press => {
            const copied = await $.ui.copy({ text: await weeklyDigest($), surface: press.surface })
            $.ui.toast(copied.isCopied ? 'GTM: weekly digest copied.' : 'GTM: could not copy here; run /gtm-digest instead.')
          }} />
        </Box>
      )
    }

    if (current === 'health') {
      const kindLabel = { stale: 'Stale', consistency: 'Mismatch', coverage: 'Gap' } as const
      return (
        <Box flexDirection="column">
          {tabs}
          <Text> </Text>
          <Text bold>Cross-pack checks</Text>
          <Text dimColor>{cut('Heuristics across packs. Warnings only; nothing is blocked.', width)}</Text>
          <Text> </Text>
          {health.length === 0 && <Text>No stale drafts, no disagreements, no missing buyers.</Text>}
          {health.map(one => (
            <Box flexDirection="column">
              <Text color="yellow">{cut(`${kindLabel[one.kind]}: ${one.message}`, width * 2)}</Text>
              {one.fix && (
                <Button key={`finding-${one.id}`} label="Fix with Claude" onPress={() => $.prompt.fill({ text: one.fix ?? '' })} />
              )}
            </Box>
          ))}
        </Box>
      )
    }

    if (current === 'views') {
      const viewTabs = (
        <Box flexDirection="row" gap={1}>
          {([['pricing', 'Pricing'], ['prospects', 'Prospects'], ['cold-email', 'Cold email'], ['evp', 'EVP'], ['geo', 'GEO'], ['founder', 'Founder']] as const)
            .map(([id, label]) => (
              <Button key={`view-${id}`} label={id === current_view ? `[${label}]` : label} plain onPress={() => loadView($, settings, id)} />
            ))}
        </Box>
      )
      return (
        <Box flexDirection="column">
          {tabs}
          {viewTabs}
          <Text> </Text>
          {await drawView($, e, settings, current_view, width)}
        </Box>
      )
    }

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
          {score?.excerpt?.split('\n').filter(line => line.trim() !== '').slice(0, 8).map(line => <Text dimColor>{cut(line.replace(/\s+/g, ' '), width)}</Text>)}
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
    const running = await read($, sprint)
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
        {running !== null && (
          <Box flexDirection="row" gap={1}>
            <Text color={running.paused ? 'yellow' : 'cyan'}>
              {cut(running.paused ? `Sprint paused: ${running.paused}` : `Sprint: ${packById(running.current)?.name ?? running.current}, through step ${running.target}`, width - 12)}
            </Text>
            <Button key="sprint-stop" label="Stop" onPress={() => update($, sprint, () => null)} />
          </Box>
        )}
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
          {step !== undefined && <Button key="run-next" label="Run next" onPress={() => runNext($, step.command)} />}
          {step !== undefined && step.n > 0 && running === null && (
            <Button key="sprint" label="Sprint" onPress={() => startSprint($, settings, 10, 'run')} />
          )}
          <Button key="refresh" label="Rescore all" onPress={() => scoreAll($, settings, undefined, true)} />
          <Button key="band" label="Show band" onPress={() => setBandHidden($, false)} />
        </Box>
      </Box>
    )
  })
}
