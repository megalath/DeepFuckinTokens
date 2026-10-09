import { countWords } from './lib/impl.js'

/**
 * Copy-me template for a deep module: this root file is the package's whole public surface,
 * and the work happens in `lib/`, which nothing outside the package may import.
 */
export function summarize(text: string): string {
  const words = countWords(text)
  return `${String(words)} ${words === 1 ? 'word' : 'words'}`
}
