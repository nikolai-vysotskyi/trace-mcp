/**
 * Session tracker — re-exports SavingsTracker as SessionTracker.
 * Matches the import expected by server.ts.
 */
export { SavingsTracker as SessionTracker } from './savings.js';
export type { SessionStats, PersistentSavings, ToolCallRecord } from './savings.js';
