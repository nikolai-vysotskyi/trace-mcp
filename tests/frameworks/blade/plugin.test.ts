import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import {
  BladePlugin,
  extractBladeDirectives,
  extractBladeSections,
  extractBladeYields,
  bladeNameToPath,
  xComponentToPath,
} from '../../../src/indexer/plugins/integration/view/blade/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/blade-laravel');

describe('BladePlugin', () => {
  let plugin: BladePlugin;

  beforeEach(() => {
    plugin = new BladePlugin();
  });

  describe('detect()', () => {
    it('returns true when resources/views has blade files', () => {
      const ctx: ProjectContext = {
        rootPath: FIXTURE_DIR,
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false when no views directory exists', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent-12345',
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });
  });

  describe('registerSchema()', () => {
    it('returns expected edge types', () => {
      const schema = plugin.registerSchema();
      const names = schema.edgeTypes!.map((e) => e.name);
      expect(names).toContain('blade_extends');
      expect(names).toContain('blade_includes');
      expect(names).toContain('blade_component');
    });

    it('all edge types have blade category', () => {
      const schema = plugin.registerSchema();
      for (const et of schema.edgeTypes!) {
        expect(et.category).toBe('blade');
      }
    });
  });

  describe('extractBladeDirectives()', () => {
    it('detects @extends', () => {
      const source = `@extends('layouts.app')`;
      const dirs = extractBladeDirectives(source);
      expect(dirs).toHaveLength(1);
      expect(dirs[0].type).toBe('extends');
      expect(dirs[0].name).toBe('layouts.app');
    });

    it('detects @include', () => {
      const source = `@include('partials.header')`;
      const dirs = extractBladeDirectives(source);
      expect(dirs).toHaveLength(1);
      expect(dirs[0].type).toBe('include');
      expect(dirs[0].name).toBe('partials.header');
    });

    it('detects @includeIf variant', () => {
      const source = `@includeIf('partials.sidebar')`;
      const dirs = extractBladeDirectives(source);
      expect(dirs).toHaveLength(1);
      expect(dirs[0].type).toBe('include');
    });

    it('detects @component', () => {
      const source = `@component('components.alert')`;
      const dirs = extractBladeDirectives(source);
      expect(dirs).toHaveLength(1);
      expect(dirs[0].type).toBe('component');
      expect(dirs[0].name).toBe('components.alert');
    });

    it('detects <x-component-name>', () => {
      const source = `<x-user-card :user="$user" />`;
      const dirs = extractBladeDirectives(source);
      expect(dirs).toHaveLength(1);
      expect(dirs[0].type).toBe('x-component');
      expect(dirs[0].name).toBe('user-card');
    });

    it('detects multiple directives', () => {
      const source = `
        @extends('layouts.app')
        @include('partials.header')
        <x-button>Click</x-button>
      `;
      const dirs = extractBladeDirectives(source);
      expect(dirs).toHaveLength(3);
    });
  });

  describe('extractBladeSections()', () => {
    it('extracts @section names', () => {
      const source = `@section('content')\n<p>Hello</p>\n@endsection`;
      expect(extractBladeSections(source)).toEqual(['content']);
    });
  });

  describe('extractBladeYields()', () => {
    it('extracts @yield names', () => {
      const source = `@yield('content')\n@yield('sidebar')`;
      expect(extractBladeYields(source)).toEqual(['content', 'sidebar']);
    });
  });

  describe('bladeNameToPath()', () => {
    it('converts dot notation to file path', () => {
      expect(bladeNameToPath('layouts.app'))
        .toBe('resources/views/layouts/app.blade.php');
    });

    it('handles nested names', () => {
      expect(bladeNameToPath('admin.users.index'))
        .toBe('resources/views/admin/users/index.blade.php');
    });
  });

  describe('xComponentToPath()', () => {
    it('converts x-component name to path', () => {
      expect(xComponentToPath('user-card'))
        .toBe('resources/views/components/user-card.blade.php');
    });
  });

  describe('manifest', () => {
    it('has correct name and dependencies', () => {
      expect(plugin.manifest.name).toBe('blade');
      expect(plugin.manifest.dependencies).toEqual(['laravel']);
    });
  });
});
