// SOUL.md voice check: phrases the operator refuses, found in any draft.

/** Bullets under "## Phrases I refuse" (or "## Phrases I never use"). */
export function refusedPhrases(soul: string): string[] {
  const out: string[] = []
  let isInSection = false
  for (const line of soul.split('\n')) {
    const heading = /^##\s+(.*)$/.exec(line)
    if (heading) {
      isInSection = /phrases i (refuse|never use)/i.test(heading[1] ?? '')
      continue
    }
    if (!isInSection) continue
    const bullet = /^\s*[-*]\s+(.+?)\s*$/.exec(line)
    if (bullet?.[1] === undefined) continue
    const phrase = bullet[1].replace(/^["'`]|["'`]$/g, '').trim()
    if (phrase.length >= 3) out.push(phrase)
  }
  return [...new Set(out)]
}

/** Every string in a draft: the text of a .md file, or the string values of a JSON one. */
export function draftText(raw: string): string {
  const trimmed = raw.trimStart()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return raw
  try {
    const strings: string[] = []
    const walk = (value: unknown): void => {
      if (typeof value === 'string') strings.push(value)
      else if (Array.isArray(value)) value.forEach(walk)
      else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk)
    }
    walk(JSON.parse(raw))
    return strings.join('\n')
  } catch {
    return raw
  }
}

/** A draft for the Detail tab: one `field: value` line per text field of a JSON draft; other drafts as they are. */
export function draftExcerpt(raw: string): string {
  const trimmed = raw.trimStart()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return raw
  try {
    const lines: string[] = []
    const walk = (value: unknown, key: string): void => {
      if (typeof value === 'string' || typeof value === 'number') {
        lines.push(key === '' ? String(value) : `${key}: ${value}`)
      } else if (Array.isArray(value)) {
        if (value.every(one => typeof one === 'string' || typeof one === 'number')) {
          if (value.length > 0) lines.push(`${key === '' ? '' : `${key}: `}${value.join(', ')}`)
        } else value.forEach(one => walk(one, key))
      } else if (value !== null && typeof value === 'object') {
        Object.entries(value).forEach(([name, one]) => walk(one, name))
      }
    }
    walk(JSON.parse(raw), '')
    return lines.join('\n')
  } catch {
    return raw
  }
}

/** The refused phrases a draft uses, whole-word and case-insensitive. */
export function voiceHits(text: string, phrases: readonly string[]): string[] {
  const escape = (phrase: string) => phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return phrases.filter(phrase => new RegExp(`(^|\\W)${escape(phrase)}(\\W|$)`, 'i').test(text))
}
