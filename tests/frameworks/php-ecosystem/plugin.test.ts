import { describe, it, expect, beforeEach } from 'vitest';
import { PhpEcosystemPlugin } from '../../../src/indexer/plugins/integration/tooling/php-ecosystem/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

function ctxWithRequire(require: Record<string, string>): ProjectContext {
  return {
    rootPath: '/tmp/nonexistent-trace-mcp-fixture-php',
    composerJson: { require },
    configFiles: [],
  };
}

describe('PhpEcosystemPlugin', () => {
  let plugin: PhpEcosystemPlugin;

  beforeEach(() => {
    plugin = new PhpEcosystemPlugin();
  });

  describe('detect()', () => {
    it('detects google/apiclient', () => {
      expect(plugin.detect(ctxWithRequire({ 'google/apiclient': '^2.0' }))).toBe(true);
    });

    it('detects laravel/ai', () => {
      expect(plugin.detect(ctxWithRequire({ 'laravel/ai': '^1.0' }))).toBe(true);
    });

    it('detects echolabsdev/prism (laravel/ai predecessor)', () => {
      expect(plugin.detect(ctxWithRequire({ 'echolabsdev/prism': '^0.1' }))).toBe(true);
    });

    it('detects symfony/dom-crawler', () => {
      expect(plugin.detect(ctxWithRequire({ 'symfony/dom-crawler': '^6.0' }))).toBe(true);
    });

    it('returns false when none of the tracked packages are present', () => {
      expect(plugin.detect(ctxWithRequire({ 'laravel/framework': '^11.0' }))).toBe(false);
    });
  });

  describe('extractNodes()', () => {
    beforeEach(() => {
      // enable the plugin so extractNodes actually inspects content
      plugin.detect(ctxWithRequire({ 'google/apiclient': '^2.0' }));
    });

    it('tags Google API client usage', () => {
      const source = Buffer.from(`<?php
use Google_Client;
$client = new Google_Client();`);
      const result = plugin.extractNodes('src/Services/Gmail.php', source, 'php');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().frameworkRole).toBe('google_api_client');
    });

    it('tags namespaced Google\\Client usage', () => {
      const source = Buffer.from(`<?php
use Google\\Client;
$client = new Google\\Client();`);
      const result = plugin.extractNodes('src/Services/Drive.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('google_api_client');
    });

    it('tags Laravel AI prompt calls', () => {
      const source = Buffer.from(`<?php
use Prism\\Prism\\Prism;
$response = Prism::text()->generate();`);
      const result = plugin.extractNodes('app/Services/Chat.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('laravel_ai_call');
    });

    it('tags Symfony DomCrawler usage', () => {
      const source = Buffer.from(`<?php
use Symfony\\Component\\DomCrawler\\Crawler;
$crawler = new Crawler($html);`);
      const result = plugin.extractNodes('src/Scraper.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('dom_crawler_usage');
    });

    it('ignores non-php languages', () => {
      const source = Buffer.from('const Google_Client = {};');
      const result = plugin.extractNodes('src/fake.ts', source, 'typescript');
      expect(result._unsafeUnwrap().frameworkRole).toBeUndefined();
    });

    it('leaves unrelated PHP files untouched', () => {
      const source = Buffer.from('<?php\nclass Plain {}');
      const result = plugin.extractNodes('src/Plain.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBeUndefined();
    });
  });
});
