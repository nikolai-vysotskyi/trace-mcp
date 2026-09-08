/**
 * Resolved user home directory.
 * Honors $HOME and $USERPROFILE if set (crucial for tests, isolated task runners,
 * and containers where os.homedir() on macOS returns the system passwd entry).
 */
import os from 'node:os';

export function getHomeDir(): string {
  return os.homedir();
}
