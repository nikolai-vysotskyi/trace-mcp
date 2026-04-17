import { describe, it, expect, beforeEach } from 'vitest';
import { JsVisualizationPlugin } from '../../../src/indexer/plugins/integration/view/js-viz/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

function ctxWithDeps(deps: Record<string, string>): ProjectContext {
  return {
    rootPath: '/tmp/nonexistent-trace-mcp-fixture-jsviz',
    packageJson: { dependencies: deps },
    configFiles: [],
  };
}

describe('JsVisualizationPlugin', () => {
  let plugin: JsVisualizationPlugin;

  beforeEach(() => {
    plugin = new JsVisualizationPlugin();
  });

  describe('detect()', () => {
    it('detects chart.js', () => {
      expect(plugin.detect(ctxWithDeps({ 'chart.js': '^4.0' }))).toBe(true);
    });

    it('detects vue-chartjs', () => {
      expect(plugin.detect(ctxWithDeps({ 'vue-chartjs': '^5.0' }))).toBe(true);
    });

    it('detects marked', () => {
      expect(plugin.detect(ctxWithDeps({ marked: '^11.0' }))).toBe(true);
    });

    it('detects vue-sonner', () => {
      expect(plugin.detect(ctxWithDeps({ 'vue-sonner': '^1.0' }))).toBe(true);
    });

    it('detects when only in devDependencies', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent-trace-mcp-fixture-jsviz',
        packageJson: { devDependencies: { marked: '^11.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false for unrelated projects', () => {
      expect(plugin.detect(ctxWithDeps({ lodash: '^4.0' }))).toBe(false);
    });
  });

  describe('extractNodes()', () => {
    beforeEach(() => {
      plugin.detect(
        ctxWithDeps({
          'chart.js': '^4.0',
          'vue-chartjs': '^5.0',
          marked: '^11.0',
          'vue-sonner': '^1.0',
        }),
      );
    });

    it('tags chart.js usage via import', () => {
      const source = Buffer.from(`import { Chart } from 'chart.js';
const chart = new Chart(ctx, config);`);
      const result = plugin.extractNodes('src/chart.ts', source, 'typescript');
      expect(result._unsafeUnwrap().frameworkRole).toBe('chart_config');
    });

    it('tags vue-chartjs component usage (takes priority over chart.js)', () => {
      const source = Buffer.from(`import { Bar } from 'vue-chartjs';
import { Chart } from 'chart.js';`);
      const result = plugin.extractNodes('src/charts/BarChart.vue', source, 'vue');
      expect(result._unsafeUnwrap().frameworkRole).toBe('vue_chart_component');
    });

    it('tags vue-sonner toast usage', () => {
      const source = Buffer.from(`import { toast } from 'vue-sonner';
toast.success('done');`);
      const result = plugin.extractNodes('src/utils/notify.ts', source, 'typescript');
      expect(result._unsafeUnwrap().frameworkRole).toBe('toast_invocation');
    });

    it('tags marked renderer usage', () => {
      const source = Buffer.from(`import { marked } from 'marked';
export const html = marked.parse(md);`);
      const result = plugin.extractNodes('src/render.ts', source, 'typescript');
      expect(result._unsafeUnwrap().frameworkRole).toBe('markdown_render');
    });

    it('ignores non-js/ts/vue languages', () => {
      const source = Buffer.from("import 'chart.js';");
      const result = plugin.extractNodes('src/style.css', source, 'css');
      expect(result._unsafeUnwrap().frameworkRole).toBeUndefined();
    });

    it('leaves unrelated files untouched', () => {
      const source = Buffer.from('export const answer = 42;');
      const result = plugin.extractNodes('src/plain.ts', source, 'typescript');
      expect(result._unsafeUnwrap().frameworkRole).toBeUndefined();
    });
  });
});
