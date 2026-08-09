/**
 * Patch Electron for dev mode. On macOS, patches the .app bundle
 * with a custom icon and name. On other platforms this is a no-op.
 */
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (process.platform === 'darwin') {
  try {
    execSync(`bash "${path.join(__dirname, 'patch-electron-dev.sh')}"`, {
      stdio: 'inherit',
    });
  } catch {
    // Non-critical — don't block dev start
    console.warn('Warning: Could not patch Electron.app for dev mode');
  }
} else {
  console.log('Skipping Electron dev patch (macOS only)');
}

// Unset ELECTRON_RUN_AS_NODE which npm may set, breaking electron startup
delete process.env.ELECTRON_RUN_AS_NODE;
