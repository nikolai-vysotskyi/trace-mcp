import { beforeEach, describe, expect, it } from 'vitest';
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

    it.each([
      ['sonner', '^1.4'],
      ['recharts', '^2.10'],
      ['framer-motion', '^11.0'],
      ['react-hook-form', '^7.50'],
      ['cmdk', '^1.0'],
      ['@vuepic/vue-datepicker', '^8.0'],
    ])('detects %s', (pkg, version) => {
      expect(plugin.detect(ctxWithDeps({ [pkg]: version }))).toBe(true);
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
          sonner: '^1.4',
          recharts: '^2.10',
          'framer-motion': '^11.0',
          'react-hook-form': '^7.50',
          cmdk: '^1.0',
          '@vuepic/vue-datepicker': '^8.0',
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

    it('tags sonner toast usage', () => {
      const source = Buffer.from(`import { toast } from 'sonner';
toast.success('done');`);
      const result = plugin.extractNodes('src/utils/notify.ts', source, 'typescript');
      expect(result._unsafeUnwrap().frameworkRole).toBe('toast_invocation');
    });

    it('tags recharts chart component', () => {
      const source = Buffer.from(`import { LineChart, Line } from 'recharts';
export const Chart = () => <LineChart data={[]}><Line /></LineChart>;`);
      const result = plugin.extractNodes('src/charts/Revenue.tsx', source, 'typescript');
      expect(result._unsafeUnwrap().frameworkRole).toBe('chart_component');
    });

    it('tags framer-motion animation usage', () => {
      const source = Buffer.from(`import { motion } from 'framer-motion';
export const Fade = () => <motion.div animate={{ opacity: 1 }} />;`);
      const result = plugin.extractNodes('src/anim/Fade.tsx', source, 'typescript');
      expect(result._unsafeUnwrap().frameworkRole).toBe('animation_component');
    });

    it('tags react-hook-form form component', () => {
      const source = Buffer.from(`import { useForm } from 'react-hook-form';
export function LoginForm() { const { register } = useForm(); return null; }`);
      const result = plugin.extractNodes('src/forms/Login.tsx', source, 'typescript');
      expect(result._unsafeUnwrap().frameworkRole).toBe('form_component');
    });

    it('tags cmdk command palette usage', () => {
      const source = Buffer.from(`import { Command } from 'cmdk';
export const Palette = () => <Command />;`);
      const result = plugin.extractNodes('src/ui/Palette.tsx', source, 'typescript');
      expect(result._unsafeUnwrap().frameworkRole).toBe('command_palette');
    });

    it('tags @vuepic/vue-datepicker usage', () => {
      const source = Buffer.from(`<script setup>
import VueDatePicker from '@vuepic/vue-datepicker';
</script>`);
      const result = plugin.extractNodes('src/forms/Date.vue', source, 'vue');
      expect(result._unsafeUnwrap().frameworkRole).toBe('datepicker_component');
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
