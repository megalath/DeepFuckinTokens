import { describe, expect, it } from 'vitest'

import { createLineSplitter } from '../src/pi/jsonl.js'

function split(chunks: readonly string[]): string[] {
  const lines: string[] = []
  const splitter = createLineSplitter((line) => lines.push(line))
  for (const chunk of chunks) splitter.push(chunk)
  splitter.end()
  return lines
}

describe('createLineSplitter', () => {
  it('splits on LF across chunk boundaries', () => {
    expect(split(['{"a":', '1}\n{"b":2}', '\n'])).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('drops a CR before LF', () => {
    expect(split(['one\r\ntwo\r\n'])).toEqual(['one', 'two'])
  })

  it('keeps U+2028 and U+2029 inside a record', () => {
    const record = JSON.stringify({ text: 'a b c' })
    expect(split([`${record}\n`])).toEqual([record])
  })

  it('emits a trailing record without LF on end, and skips blank lines', () => {
    expect(split(['\n\nlast'])).toEqual(['last'])
  })
})
