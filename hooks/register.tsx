import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GtmBoard } from '../types'
import {
  PACKS,
  applyEdit,
  buildBoard,
  doneCount,
  mergeViolations,
  nextStep,
  parseConfig,
  soulViolations,
  summary,
} from './gtm'

const PANE = 'gtm-board'
const CONFIG = 'brand-config.json'
const SOUL = 'SOUL.md'

const board = atom({ plugin: 'gtm-operator', key: 'board' } as const, null)
const isBandHidden = atom({ plugin: 'gtm-operator', key: 'isBandHidden' } as const, false)
const isGuardOff = atom({ plugin: 'gtm-operator', key: 'isGuardOff' } as const, false)

type $ = EngineInterface

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

async function readText($: $, path: string): Promise<string | undefined> {
  return (await $.fs.exists(path)) ? await $.fs.read(path) : undefined
}

async function scan($: $): Promise<GtmBoard> {
  const root = (await $.session.root()).replace(/[\\/]$/, '')
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

function statusLine(found: GtmBoard): string | undefined {
  if (!found.hasProject) return undefined
  const next = nextStep(found)
  const tail = next === undefined ? 'all steps done' : `next ${next.command}`
  return `GTM ${doneCount(found)}/${found.steps.length} · ${tail}`
}

async function refresh($: $, isAnnounced = false): Promise<GtmBoard> {
  const found = await scan($)
  const before = await read($, board)
  await update($, board, () => found)
  $.ui.status(statusLine(found))

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

function guardMessage(file: string, lost: string[]): string {
  const shown = lost.slice(0, 6).join(', ') + (lost.length > 6 ? `, +${lost.length - 6} more` : '')
  return `gtm-operator: this write to ${file} would drop or change values that already exist (${shown}). ` +
    'The GTM suite merges, never overwrites: keep every existing key and value, change only the fields ' +
    'this pack owns, and ask the person before changing a field that already has a value. ' +
    'If they confirmed the change, they can run /gtm-guard off and you can retry.'
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'gtm-board',
      description: 'GTM suite board: what is done, and the next pack to run',
      argumentHint: '[refresh]',
    })
    await $.command.register({
      name: 'gtm-guard',
      description: 'Turn the brand-config.json / SOUL.md overwrite guard on or off',
      argumentHint: '[on|off]',
    })
    await refresh($)
    $.clock.every(30_000, () => void refresh($, true))

    return next(e)
  })

  on('command.run', { command: 'gtm-board' }, async $ => {
    const found = await refresh($)
    if (!found.hasProject) {
      return {
        text: 'No GTM project here yet: no brand-config.json and no gtm/ folder.\n' +
          'Next: /gtm:setup — asks the shared questions once. ' +
          'Install the suite with /plugin install gtm@gtm-operator-skills.',
      }
    }
    await $.ui.open({ id: PANE, title: 'GTM board' })

    return { text: summary(found) }
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
    const reason = await guard($, e.file_path, e.content)
    return reason === undefined ? next(e) : { deny: reason }
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const root = await $.session.root()
    const rel = relative(e.file_path, root)
    if (rel !== CONFIG && rel !== SOUL) return next(e)
    const before = await readText($, `${root.replace(/[\\/]$/, '')}/${rel}`).catch(() => undefined)
    const after = before === undefined
      ? undefined
      : applyEdit(before, e.old_string, e.new_string, e.replace_all === true)
    const reason = after === undefined ? undefined : await guard($, e.file_path, after)
    return reason === undefined ? next(e) : { deny: reason }
  })

  // Anything that may have written the suite's files redraws the board.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const tool = String(e.tool)
    if (ran.deny !== undefined || !['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'].includes(tool)) {
      return ran
    }
    const path = 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : undefined
    const isRelevant = tool === 'Bash' || isTracked(relative(path ?? '', await $.session.root()))
    if (isRelevant) await refresh($, true)

    return ran
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const found = await read($, board)
    if (found === null || !found.hasProject) return composed

    const text = '# GTM operator suite state (from the gtm-operator mod)\n' +
      'This project uses the GTM operator skill packs. brand-config.json and SOUL.md are shared: ' +
      'merge field by field, never rewrite them, and ask before changing a filled value. ' +
      'Drafts live in gtm/, one file per pack.\n' + summary(found)

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
    const step = nextStep(found)
    const count = `GTM ${doneCount(found)}/${found.steps.length}`

    return (
      <Box flexDirection="row" gap={1}>
        <Text bold>{count}</Text>
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
        <Button key="hide" label="Hide" onPress={() => update($, isBandHidden, () => true)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const found = await read($, board)
    const width = Math.max(20, e.props.bodyColumns ?? e.viewport?.columns ?? 60)
    const cut = (text: string, room: number) =>
      text.length <= room ? text : `${text.slice(0, Math.max(1, room - 1))}…`

    if (found === null || !found.hasProject) {
      return (
        <Box flexDirection="column">
          <Text>No GTM project here yet.</Text>
          <Text dimColor>Run /gtm:setup to answer the shared questions once.</Text>
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
        <Text bold>
          {doneCount(found)}/{found.steps.length} steps in place
        </Text>
        {facts.map(([label, value]) => (
          <Text dimColor={value === ''}>
            {cut(`${label}: ${value === '' ? '—' : value}`, width)}
          </Text>
        ))}
        <Text> </Text>
        {found.steps.map(one => (
          <Text bold={one === step} dimColor={one.isDone}>
            {cut(`${one.isDone ? '✓' : one === step ? '▸' : '·'} ${one.n}. ${one.name}  ${one.isDone ? one.check : one.command}`, width)}
          </Text>
        ))}
        <Text> </Text>
        {step !== undefined && (
          <Text>
            {cut(`Next: ${step.command} — ${step.why}`, width)}
          </Text>
        )}
        {step !== undefined && (
          <Text dimColor>
            {cut(`Not installed? /plugin install ${PACKS[step.command] ?? 'gtm'}@gtm-operator-skills`, width)}
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
          <Button key="refresh" label="Refresh" onPress={() => refresh($)} />
          <Button key="band" label="Show band" onPress={() => update($, isBandHidden, () => false)} />
        </Box>
      </Box>
    )
  })
}
