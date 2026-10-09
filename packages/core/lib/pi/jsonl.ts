/**
 * Strict JSONL framing as pi specifies it: records end at LF only (an optional
 * CR before it is dropped). Unlike `readline`, U+2028 and U+2029 stay inside
 * records, where JSON strings may legally hold them.
 */
export interface LineSplitter {
  push(chunk: string): void
  /** Emits a trailing record that had no final LF. */
  end(): void
}

export function createLineSplitter(onLine: (line: string) => void): LineSplitter {
  let buffered = ''
  const emit = (raw: string): void => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.length > 0) onLine(line)
  }
  return {
    push(chunk) {
      buffered += chunk
      let newline = buffered.indexOf('\n')
      while (newline !== -1) {
        emit(buffered.slice(0, newline))
        buffered = buffered.slice(newline + 1)
        newline = buffered.indexOf('\n')
      }
    },
    end() {
      emit(buffered)
      buffered = ''
    },
  }
}
