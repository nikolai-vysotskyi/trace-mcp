import { describe, expect, it } from 'vitest';
import { isSensitiveFile } from '../security.js';

// ─── Test matrix for isSensitiveFile ────────────────────────────────────────
// Rule 1 — basename patterns: match specific credential/key basenames only.
//           Source extensions (.ts, .js, .go, …) never trigger exclusion.
// Rule 2 — secret-store dir: whole-segment "secret"/"secrets" parent dir
//           AND a data/credential extension triggers exclusion.
//           Source files under such dirs remain indexed.
//           Substring dir names like "secrets-manager" do NOT trigger.

describe('isSensitiveFile', () => {
  // ── MUST be excluded ──────────────────────────────────────────────────────

  describe('excluded — env files (Rule 1: basename)', () => {
    it('.env', () => expect(isSensitiveFile('.env')).toBe(true));
    it('.env.local', () => expect(isSensitiveFile('.env.local')).toBe(true));
    it('.env.production', () => expect(isSensitiveFile('.env.production')).toBe(true));
    it('config/.env', () => expect(isSensitiveFile('config/.env')).toBe(true));
    it('app.env (*.env)', () => expect(isSensitiveFile('app.env')).toBe(true));
  });

  describe('excluded — certificates & keys (Rule 1: basename)', () => {
    it('server.pem', () => expect(isSensitiveFile('server.pem')).toBe(true));
    it('certs/server.pem', () => expect(isSensitiveFile('certs/server.pem')).toBe(true));
    it('private.key', () => expect(isSensitiveFile('private.key')).toBe(true));
    it('cert.crt', () => expect(isSensitiveFile('cert.crt')).toBe(true));
    it('keystore.p12', () => expect(isSensitiveFile('keystore.p12')).toBe(true));
    it('keystore.pfx', () => expect(isSensitiveFile('keystore.pfx')).toBe(true));
    it('cert.cer', () => expect(isSensitiveFile('cert.cer')).toBe(true));
    it('app.jks', () => expect(isSensitiveFile('app.jks')).toBe(true));
    it('app.keystore', () => expect(isSensitiveFile('app.keystore')).toBe(true));
  });

  describe('excluded — SSH keys (Rule 1: basename)', () => {
    it('id_rsa', () => expect(isSensitiveFile('id_rsa')).toBe(true));
    it('id_rsa.pub', () => expect(isSensitiveFile('id_rsa.pub')).toBe(true));
    it('.ssh/id_rsa', () => expect(isSensitiveFile('.ssh/id_rsa')).toBe(true));
    it('id_ed25519', () => expect(isSensitiveFile('id_ed25519')).toBe(true));
    it('id_ed25519.pub', () => expect(isSensitiveFile('id_ed25519.pub')).toBe(true));
    it('id_dsa', () => expect(isSensitiveFile('id_dsa')).toBe(true));
    it('id_ecdsa', () => expect(isSensitiveFile('id_ecdsa')).toBe(true));
  });

  describe('excluded — credential/token files (Rule 1: basename)', () => {
    it('credentials.json', () => expect(isSensitiveFile('credentials.json')).toBe(true));
    it('service-account.json', () => expect(isSensitiveFile('service-account.json')).toBe(true));
    it('service-account-prod.json', () =>
      expect(isSensitiveFile('service-account-prod.json')).toBe(true));
    it('app.credentials', () => expect(isSensitiveFile('app.credentials')).toBe(true));
    it('auth.token', () => expect(isSensitiveFile('auth.token')).toBe(true));
    it('config.secrets', () => expect(isSensitiveFile('config.secrets')).toBe(true));
  });

  describe('excluded — auth config files (Rule 1: basename)', () => {
    it('.htpasswd', () => expect(isSensitiveFile('.htpasswd')).toBe(true));
    it('.netrc', () => expect(isSensitiveFile('.netrc')).toBe(true));
    it('.npmrc', () => expect(isSensitiveFile('.npmrc')).toBe(true));
    it('.pypirc', () => expect(isSensitiveFile('.pypirc')).toBe(true));
  });

  describe('excluded — secret-store directory + data extension (Rule 2)', () => {
    // Whole-segment "secrets" dir + data extensions
    it('config/secrets/database.yaml', () =>
      expect(isSensitiveFile('config/secrets/database.yaml')).toBe(true));
    it('k8s/secrets/db.yaml', () => expect(isSensitiveFile('k8s/secrets/db.yaml')).toBe(true));
    it('k8s/secrets/db.yml', () => expect(isSensitiveFile('k8s/secrets/db.yml')).toBe(true));
    it('infra/secrets/terraform.tfvars', () =>
      expect(isSensitiveFile('infra/secrets/terraform.tfvars')).toBe(true));
    it('infra/secrets/state.tfstate', () =>
      expect(isSensitiveFile('infra/secrets/state.tfstate')).toBe(true));
    it('docker/secrets/db.json', () =>
      expect(isSensitiveFile('docker/secrets/db.json')).toBe(true));
    it('config/secrets/app.toml', () =>
      expect(isSensitiveFile('config/secrets/app.toml')).toBe(true));
    it('config/secrets/app.ini', () =>
      expect(isSensitiveFile('config/secrets/app.ini')).toBe(true));
    it('config/secrets/app.conf', () =>
      expect(isSensitiveFile('config/secrets/app.conf')).toBe(true));
    it('config/secrets/app.env', () =>
      expect(isSensitiveFile('config/secrets/app.env')).toBe(true));

    // Singular "secret" dir also triggers
    it('config/secret/database.yaml', () =>
      expect(isSensitiveFile('config/secret/database.yaml')).toBe(true));

    // Deep nesting: secret dir is not the immediate parent
    it('project/secrets/subdir/config.yaml', () =>
      expect(isSensitiveFile('project/secrets/subdir/config.yaml')).toBe(true));

    // Case-insensitive dir matching
    it('config/SECRETS/database.yaml', () =>
      expect(isSensitiveFile('config/SECRETS/database.yaml')).toBe(true));
    it('config/Secrets/database.yaml', () =>
      expect(isSensitiveFile('config/Secrets/database.yaml')).toBe(true));
  });

  // ── MUST be indexed (not flagged) ────────────────────────────────────────

  describe('indexed — source file with "secret" in basename (Rule 1: source ext exempt)', () => {
    // Source extensions must never be blocked by any "secret" substring match.
    it('src/secret-utils.ts', () => expect(isSensitiveFile('src/secret-utils.ts')).toBe(false));
    it('secret-handler.ts', () => expect(isSensitiveFile('secret-handler.ts')).toBe(false));
    it('my-secret-service.js', () => expect(isSensitiveFile('my-secret-service.js')).toBe(false));
    it('secretManager.py', () => expect(isSensitiveFile('secretManager.py')).toBe(false));
    it('secret_store.go', () => expect(isSensitiveFile('secret_store.go')).toBe(false));
    it('SecretController.java', () => expect(isSensitiveFile('SecretController.java')).toBe(false));
    it('secret_repo.rb', () => expect(isSensitiveFile('secret_repo.rb')).toBe(false));
    it('secrets.rs', () => expect(isSensitiveFile('secrets.rs')).toBe(false));
  });

  describe('indexed — source file under secret-store dir (Rule 2: source ext exempt)', () => {
    // Rule 2 fires only on data/credential extensions, not source code.
    it('internal/secrets/router.go', () =>
      expect(isSensitiveFile('internal/secrets/router.go')).toBe(false));
    it('k8s/secrets/controller.ts', () =>
      expect(isSensitiveFile('k8s/secrets/controller.ts')).toBe(false));
    it('config/secrets/validator.py', () =>
      expect(isSensitiveFile('config/secrets/validator.py')).toBe(false));
    it('app/secrets/handler.rb', () =>
      expect(isSensitiveFile('app/secrets/handler.rb')).toBe(false));
    it('lib/secrets/util.js', () => expect(isSensitiveFile('lib/secrets/util.js')).toBe(false));
    it('src/secrets/README.md', () => expect(isSensitiveFile('src/secrets/README.md')).toBe(false));
  });

  describe('indexed — substring dir names are not secret stores (Rule 2: whole-segment only)', () => {
    // "secrets-manager" is NOT a whole segment equal to "secrets".
    it('services/secrets-manager/index.ts', () =>
      expect(isSensitiveFile('services/secrets-manager/index.ts')).toBe(false));
    it('services/secrets-manager/config.yaml', () =>
      expect(isSensitiveFile('services/secrets-manager/config.yaml')).toBe(false));
    it('aws-secrets-manager/handler.go', () =>
      expect(isSensitiveFile('aws-secrets-manager/handler.go')).toBe(false));
    it('aws-secrets-manager/policy.json', () =>
      expect(isSensitiveFile('aws-secrets-manager/policy.json')).toBe(false));
    it('my-secret-store/config.yaml', () =>
      expect(isSensitiveFile('my-secret-store/config.yaml')).toBe(false));
    it('secretsmanager/config.yaml', () =>
      expect(isSensitiveFile('secretsmanager/config.yaml')).toBe(false));
  });

  describe('indexed — ordinary source/config files not matching any rule', () => {
    it('src/index.ts', () => expect(isSensitiveFile('src/index.ts')).toBe(false));
    it('README.md', () => expect(isSensitiveFile('README.md')).toBe(false));
    it('docs/secrets-handling.md', () =>
      expect(isSensitiveFile('docs/secrets-handling.md')).toBe(false));
    it('package.json', () => expect(isSensitiveFile('package.json')).toBe(false));
    it('tsconfig.json', () => expect(isSensitiveFile('tsconfig.json')).toBe(false));
    it('vitest.config.ts', () => expect(isSensitiveFile('vitest.config.ts')).toBe(false));
    it('src/utils/token-counter.ts ("token" in name, source ext)', () =>
      expect(isSensitiveFile('src/utils/token-counter.ts')).toBe(false));
  });
});
