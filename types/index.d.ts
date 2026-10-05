export type GtmStep = {
  n: number
  name: string
  check: string
  command: string
  why: string
  isDone: boolean
}

export type GtmBoard = {
  hasProject: boolean
  steps: GtmStep[]
  operator: string
  segment: string
  pain: string
  valueLine: string
  checkedAt: number
}

export type PackId =
  | 'psp'
  | 'evp'
  | 'list'
  | 'letter'
  | 'offer'
  | 'price'
  | 'page'
  | 'sequence'
  | 'findability'
  | 'posts'

export type ScoreStatus = 'pass' | 'fail' | 'missing' | 'unknown'

export type Axis = { name: string; score: number; max: number; notes: string[] }

export type Score = {
  pack: PackId
  status: ScoreStatus
  /** 0-100 when the scorer reports one. */
  score?: number
  reasons: string[]
  fixes: string[]
  axes: Axis[]
  next?: string
  verdict?: string
  /** Why the status is missing or unknown. */
  detail?: string
  /** SOUL.md phrases the draft uses. */
  voice?: string[]
  /** The draft's text, cut for display. */
  excerpt?: string
  /** ms since the epoch. */
  at: number
}

export type Scores = Partial<Record<PackId, Score>>

export type Sample = { at: number; score?: number; status: ScoreStatus; fixes: number }

export type History = Partial<Record<PackId, Sample[]>>

export type Finding = {
  id: string
  kind: 'stale' | 'consistency' | 'coverage'
  packs: PackId[]
  message: string
  /** The prompt "Fix with Claude" fills in. */
  fix?: string
}

export type ViewId = 'pricing' | 'prospects' | 'cold-email' | 'evp' | 'geo' | 'founder'

/** Output of the extra pack tools a view runs (waterfall, decoy, lint, ...), by tool. */
export type ToolRuns = Partial<Record<string, { at: number; exitCode: number; stdout: string; stderr: string }>>

/** A logged result, tied to the letter version that was live. */
export type Outcome = { at: number; kind: 'replies' | 'meetings'; count: number; version: string; score?: number }

export type Sprint = {
  /** The pack whose turn is running. */
  current: PackId
  /** Stop after this step number. */
  target: number
  startedAt: number
  /** Why it paused, when it did. */
  paused?: string
}

export type Tab = 'board' | 'detail' | 'health' | 'views' | 'analytics'

declare module 'claude-code' {
  interface PluginState {
    'gtm-operator': {
      board: GtmBoard | null
      scores: Scores
      history: History
      tab: Tab
      selected: PackId
      findings: Finding[]
      view: ViewId
      toolRuns: ToolRuns
      sprint: Sprint | null
      outcomes: Outcome[]
      isBandHidden: boolean
      isGuardOff: boolean
    }
  }

  // The tools this mod registers with $.tool.register, so its own tool.call
  // matchers type-check whatever MCP servers the machine has connected.
  interface McpToolInputs {
    'mcp__gtm-operator__gtm_status': Record<string, never>
    'mcp__gtm-operator__gtm_score': { pack?: string; file?: string }
    'mcp__gtm-operator__gtm_consistency': Record<string, never>
  }
}
