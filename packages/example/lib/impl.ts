/** Hidden behind `index.ts`: free to change shape without touching any caller. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length
}
