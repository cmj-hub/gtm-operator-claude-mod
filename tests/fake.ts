// A fake project served beneath the mod: files, the store, HOME, and the packs'
// scorers answered from recorded output. A draft containing "BAD" gets the
// pack's failing fixture; anything else gets the passing one.
import type { On } from 'claude-code'

import { PACKS } from '../hooks/packs'
import { FIXTURES } from './fixtures'

export const ROOT = '/work/acme'
export const HOME = '/home/op'
export const NOW = Date.UTC(2026, 9, 5)
export const CACHE = `${HOME}/.claude/plugins/cache/gtm-operator-skills`

export const RUN = {
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const

export const CONFIG = {
  operator: { name: 'Jay', company: 'Acme' },
  icp: { segment: 'Series-B SaaS, 50-200 people, US', role_targets: ['VP Sales', 'CRO'] },
  psp: { primary_pain: 'reps miss renewal signals', signal_anchors: ['new CRO hired'] },
}

export const SITE = {
  plugin: 'gtm-operator',
  props: { scroll: { offset: 0, bodyRows: 40 }, view: {} },
}

export const PANE_PROPS = {
  title: 'GTM board', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {},
} as const

export const BAND_PROPS = {
  hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, view: {},
} as const

type File = { text: string; mtimeMs: number }

export type Fake = {
  files: Map<string, File>
  store: Map<string, unknown>
  toasts: string[]
  fills: string[]
  runs: string[][]
  write: (rel: string, text: string) => void
}

export type FakeOptions = {
  /** Project files by path relative to ROOT. */
  files?: Record<string, string>
  /** Install the ten packs' scorers in the plugin cache (default true). */
  isInstalled?: boolean
  /** session.root fails this many times first. */
  failedRoots?: number
}

const abs = (path: string) => (path.startsWith('/') ? path : `${ROOT}/${path}`)

export function fake(on: On, options: FakeOptions = {}): Fake {
  const files = new Map<string, File>()
  let tick = 0
  const put = (path: string, text: string) => files.set(abs(path), { text, mtimeMs: NOW + ++tick })
  for (const [path, text] of Object.entries(options.files ?? { 'brand-config.json': JSON.stringify(CONFIG, null, 2) })) {
    put(path, text)
  }
  if (options.isInstalled !== false) {
    for (const pack of PACKS) put(`${CACHE}/${pack.plugin}/0.7.0/${pack.scorer}`, '# scorer')
  }

  const store = new Map<string, unknown>()
  const toasts: string[] = []
  const fills: string[] = []
  const runs: string[][] = []

  const isDir = (path: string) => [...files.keys()].some(one => one.startsWith(`${path.replace(/\/$/, '')}/`))
  const children = (path: string) => {
    const base = `${path.replace(/\/$/, '')}/`
    const names = new Map<string, 'file' | 'dir'>()
    for (const key of files.keys()) {
      if (!key.startsWith(base)) continue
      const rest = key.slice(base.length)
      const name = rest.split('/')[0] ?? ''
      names.set(name, rest.includes('/') ? 'dir' : 'file')
    }
    return [...names].map(([name, kind]) => {
      const file = files.get(`${base}${name}`)
      return { name, kind, size: file?.text.length ?? 0, mtimeMs: file?.mtimeMs ?? 0, isLink: false }
    })
  }

  let roots = 0
  const failedRoots = options.failedRoots ?? 0
  on('session.root', () => (++roots <= failedRoots ? { deny: 'unavailable' } : { value: ROOT }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.fill', (_$, e) => {
    fills.push(e.text)
    return { isFilled: true }
  })
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: files.has(abs(e.path)) || isDir(abs(e.path)) }))
  on('fs.read', (_$, e) => {
    const file = files.get(abs(e.path))
    return file === undefined ? { deny: 'ENOENT' } : { value: file.text }
  })
  on('fs.list', (_$, e) => (isDir(abs(e.path)) ? { value: children(abs(e.path)) } : { deny: 'ENOENT' }))
  on('fs.stat', (_$, e) => {
    const file = files.get(abs(e.path))
    if (file !== undefined) return { value: { kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } }
    return isDir(abs(e.path)) ? { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } } : { deny: 'ENOENT' }
  })
  const result = (exitCode: number, stdout: string, stderr = '') =>
    ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    const scorer = argv[1] ?? ''
    const pack = PACKS.find(one => scorer.endsWith(one.scorer))
    if (pack === undefined) return result(2, '', 'unknown scorer')
    const fileArg = argv.indexOf('--file')
    const textArg = Math.max(argv.indexOf('--evp'), argv.indexOf('--post'))
    const input = fileArg >= 0 ? files.get(argv[fileArg + 1] ?? '')?.text ?? ''
      : textArg >= 0 ? argv[textArg + 1] ?? ''
      : e.init?.stdin ?? ''
    const recorded = FIXTURES[`${pack.id}-${input.includes('BAD') ? 'bad' : 'good'}`]
    if (recorded === undefined) return result(2, '', 'no fixture')
    return result(recorded.exitCode, recorded.stdout)
  })

  return { files, store, toasts, fills, runs, write: put }
}
