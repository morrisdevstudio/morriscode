import { describe, expect, it } from 'vitest'
import { prepareSpeechMessage, prepareSpeechText } from './speech.js'

describe('speech preparation', () => {
  it('keeps explanations, headings, lists and link labels', () => {
    const result = prepareSpeechText(
      '## Résultat\n\nLe bouton est prêt, voir [la documentation](https://example.com/private).\n\n- Première étape\n- Deuxième étape',
    )

    expect(result.chunks.join(' ')).toContain('Résultat')
    expect(result.chunks.join(' ')).toContain('la documentation')
    expect(result.chunks.join(' ')).toContain('Première étape')
    expect(result.chunks.join(' ')).not.toContain('example.com')
    expect(result.chunks.join(' ')).not.toContain('##')
  })

  it('omits fenced code and bare URLs', () => {
    const result = prepareSpeechText(
      'Voici le correctif.\n\n```ts\nconst secret = process.env.KEY\n```\n\nDétails sur https://example.com/path.',
    )

    expect(result.chunks.join(' ')).toBe('Voici le correctif. Détails sur')
    expect(result.chunks.join(' ')).not.toContain('secret')
    expect(result.chunks.join(' ')).not.toContain('https://')
  })

  it('uses text segments in order and ignores reasoning-only messages', () => {
    expect(prepareSpeechMessage('fallback', ['Première partie.', 'Deuxième partie.']).chunks).toEqual([
      'Première partie. Deuxième partie.',
    ])
    expect(prepareSpeechText('```sh\nnpm test\n```').chunks).toEqual([])
  })

  it('keeps every long chunk within the synthesizer limit', () => {
    const longSentence = Array.from({ length: 120 }, (_, index) => 'mot' + index).join(' ')
    const chunks = prepareSpeechText(longSentence).chunks

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.length <= 180)).toBe(true)
    expect(chunks.join(' ')).toBe(longSentence)
  })
})
