import { describe, expect, it } from 'vitest'

import { summarize } from '../index.js'

describe('example package', () => {
  it('is exercised through its entry point', () => {
    expect(summarize('deep modules hide a lot')).toBe('5 words')
    expect(summarize('one')).toBe('1 word')
  })
})
