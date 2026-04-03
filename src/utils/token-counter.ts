/**
 * Token estimation: chars/4 * 1.15
 * Trade-off: speed > accuracy, ~15-20% margin.
 */
export function estimateTokens(text: string): number {
  return Math.ceil((text.length / 4) * 1.15);
}
