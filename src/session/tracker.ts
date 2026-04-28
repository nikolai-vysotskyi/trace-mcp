/**
 * Session tracker — re-exports SavingsTracker as SessionTracker.
 * Matches the import expected by server.ts.
 */

export type { PersistentSavings, SessionStats, ToolCallRecord } from '../savings.js';
export { SavingsTracker as SessionTracker } from '../savings.js';
