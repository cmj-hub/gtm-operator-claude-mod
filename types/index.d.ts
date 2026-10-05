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

declare module 'claude-code' {
  interface PluginState {
    'gtm-operator': {
      board: GtmBoard | null
      isBandHidden: boolean
      isGuardOff: boolean
    }
  }
}
