// The ten packs of the GTM operator suite: where each scorer lives in its
// repo, and which project file or field it scores.
import type { PackId } from '../types'

/** What a scorer reads from the project. */
export type DraftSource =
  | { kind: 'file'; path: string }
  | { kind: 'config'; field: string }
  | { kind: 'config-text'; field: string }
  | { kind: 'latest'; dir: string; ext: readonly string[] }

export type PackDef = {
  id: PackId
  /** Step in the suite walk (matches GtmStep.n). */
  step: number
  name: string
  plugin: string
  repo: string
  /** The skill directory name, as the skills CLI installs it. */
  skill: string
  command: string
  draft: DraftSource
  /** Scorer path relative to the repo root. */
  scorer: string
  /** Scorer path relative to the installed skill directory, when it differs. */
  skillScorer?: string
  /** Builds the scorer's arguments for one input. */
  args: (input: ScorerInput) => string[]
}

export type ScorerInput = { file: string } | { stdin: string } | { text: string }

const fileOrStdin = (input: ScorerInput): string[] =>
  'file' in input ? ['--file', input.file] : ['--stdin']

export const PACKS: readonly PackDef[] = [
  {
    id: 'psp',
    step: 1,
    name: 'Profile (PSP)',
    plugin: 'psp',
    repo: 'claude-psp',
    skill: 'psp',
    command: '/psp:psp',
    draft: { kind: 'config', field: 'psp' },
    scorer: 'scripts/score_psp.py',
    args: input =>
      'file' in input ? ['--file', input.file, '--json-path', 'psp'] : ['--stdin'],
  },
  {
    id: 'evp',
    step: 2,
    name: 'Value line (EVP)',
    plugin: 'evp',
    repo: 'claude-evp',
    skill: 'evp',
    command: '/evp:evp',
    draft: { kind: 'config-text', field: 'evp.primary' },
    scorer: 'scripts/score_evp.py',
    args: input =>
      'text' in input ? ['--evp', input.text] : fileOrStdin(input),
  },
  {
    id: 'list',
    step: 3,
    name: 'Prospect list',
    plugin: 'prospect-list',
    repo: 'claude-prospect-list',
    skill: 'who-to-contact',
    command: '/prospect-list:who-to-contact',
    draft: { kind: 'file', path: 'gtm/list.json' },
    scorer: 'skills/who-to-contact/scripts/score.py',
    skillScorer: 'scripts/score.py',
    args: fileOrStdin,
  },
  {
    id: 'letter',
    step: 4,
    name: 'First touch',
    plugin: 'cold-email',
    repo: 'claude-cold-email',
    skill: 'cold-email',
    command: '/cold-email:cold-email',
    draft: { kind: 'file', path: 'gtm/letter.json' },
    scorer: 'scripts/score_letter.py',
    args: fileOrStdin,
  },
  {
    id: 'offer',
    step: 5,
    name: 'Offer',
    plugin: 'sales-offer',
    repo: 'claude-sales-offer',
    skill: 'cold-offer',
    command: '/sales-offer:cold-offer',
    draft: { kind: 'file', path: 'gtm/offer.json' },
    scorer: 'skills/cold-offer/scripts/score.py',
    skillScorer: 'scripts/score.py',
    args: fileOrStdin,
  },
  {
    id: 'price',
    step: 6,
    name: 'Pricing',
    plugin: 'pricing',
    repo: 'claude-pricing',
    skill: 'pricing',
    command: '/pricing:pricing',
    draft: { kind: 'file', path: 'gtm/price.json' },
    scorer: 'scripts/score_price.py',
    args: fileOrStdin,
  },
  {
    id: 'page',
    step: 7,
    name: 'Landing page',
    plugin: 'landing-page',
    repo: 'claude-landing-page',
    skill: 'page',
    command: '/landing-page:page',
    draft: { kind: 'file', path: 'gtm/page.json' },
    scorer: 'scripts/score.py',
    args: fileOrStdin,
  },
  {
    id: 'sequence',
    step: 8,
    name: 'Email sequence',
    plugin: 'email-sequence',
    repo: 'claude-email-sequence',
    skill: 'lifecycle-email',
    command: '/email-sequence:lifecycle-email',
    draft: { kind: 'file', path: 'gtm/sequence.json' },
    scorer: 'scripts/score.py',
    args: fileOrStdin,
  },
  {
    id: 'findability',
    step: 9,
    name: 'Findability (GEO)',
    plugin: 'geo',
    repo: 'claude-geo',
    skill: 'geo',
    command: '/geo:geo',
    draft: { kind: 'file', path: 'gtm/findability.json' },
    scorer: 'scripts/score.py',
    args: fileOrStdin,
  },
  {
    id: 'posts',
    step: 10,
    name: 'Founder posts',
    plugin: 'founder-brand',
    repo: 'claude-founder-brand',
    skill: 'founder-brand',
    command: '/founder-brand:founder-brand',
    draft: { kind: 'latest', dir: 'drafts', ext: ['.md', '.txt'] },
    scorer: 'scripts/score_post.py',
    // --stdin takes JSON ({ "post": ... }); a Markdown post goes in --post.
    args: input =>
      'file' in input ? ['--file', input.file]
        : 'text' in input ? ['--post', input.text]
        : input.stdin.trimStart().startsWith('{') ? ['--stdin'] : ['--post', input.stdin],
  },
]

export function packById(id: string): PackDef | undefined {
  return PACKS.find(pack => pack.id === id)
}

/** The pack whose draft lives at this project-relative path, if any. */
export function packForPath(rel: string): PackDef | undefined {
  return PACKS.find(pack => {
    const draft = pack.draft
    if (draft.kind === 'file') return draft.path === rel
    if (draft.kind === 'latest') {
      return rel.startsWith(`${draft.dir}/`) && draft.ext.some(ext => rel.endsWith(ext))
    }
    return false
  })
}
