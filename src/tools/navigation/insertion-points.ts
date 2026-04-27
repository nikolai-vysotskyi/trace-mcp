/**
 * Framework-aware insertion-point suggestions for plan_turn.
 *
 * When plan_turn determines a feature is missing, this module proposes WHERE to
 * scaffold it based on the detected framework(s) and the natural-language task.
 * Each suggestion includes:
 *   - target file (the parent file the agent should open)
 *   - framework name and reason
 *   - scaffold_hint (what kind of code to write)
 *   - related_files (sibling files that typically need updates: route, test, config)
 *
 * Suggestions are intentionally conservative — we list the canonical conventional
 * locations the agent can confirm with `get_outline` or `Read`. Precedence: framework
 * specificity → first hit wins. Generic fallback uses the closest existing partial
 * match (top target's directory) when no framework matches.
 */
import type { Store } from '../../db/store.js';

export interface InsertionPoint {
  /** File path the agent should open with get_outline / Read */
  file: string;
  /** Optional symbol name to insert after (e.g. "Route::resource") */
  after_symbol?: string;
  /** Framework that motivated this suggestion */
  framework: string;
  /** One-line explanation of why this location */
  reason: string;
  /** Compact scaffold instruction (e.g. "Add a new POST route + controller method + FormRequest") */
  scaffold_hint: string;
  /** Sibling files that usually need updates alongside the primary file */
  related_files: string[];
}

interface InsertionContext {
  store: Store;
  has: (...names: string[]) => boolean;
}

interface PartialTarget {
  file: string;
}

// ═══════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════

export function suggestInsertionPoints(
  ctx: InsertionContext,
  task: string,
  topTargets: PartialTarget[],
): InsertionPoint[] {
  const lower = task.toLowerCase();
  const featureKind = detectFeatureKind(lower);
  const points: InsertionPoint[] = [];

  // Iterate framework rules in priority order; first matching framework wins.
  for (const rule of FRAMEWORK_RULES) {
    if (!ctx.has(rule.framework)) continue;
    const matched = rule.match(featureKind, lower, ctx);
    if (matched.length > 0) {
      points.push(...matched);
      break;
    }
  }

  // Generic fallback: if no framework rule matched, suggest a sibling next to the
  // closest partial match (top target's directory).
  if (points.length === 0 && topTargets.length > 0) {
    const dir = topTargets[0].file.split('/').slice(0, -1).join('/');
    points.push({
      file: dir || topTargets[0].file,
      framework: 'generic',
      reason: 'No framework convention matched — suggested sibling of closest existing match',
      scaffold_hint: `Create a new file in ${dir || '.'} mirroring the structure of ${topTargets[0].file}`,
      related_files: [],
    });
  }

  return points.slice(0, 3);
}

// ═══════════════════════════════════════════════════════════════════
// FEATURE-KIND DETECTION
// ═══════════════════════════════════════════════════════════════════

type FeatureKind =
  | 'endpoint'
  | 'route'
  | 'controller'
  | 'model'
  | 'migration'
  | 'middleware'
  | 'command'
  | 'job'
  | 'event'
  | 'listener'
  | 'view'
  | 'page'
  | 'component'
  | 'service'
  | 'test'
  | 'unknown';

function detectFeatureKind(lower: string): FeatureKind {
  if (/\b(endpoint|api|rest|graphql|http|webhook)\b/.test(lower)) return 'endpoint';
  if (/\broute\b/.test(lower)) return 'route';
  if (/\bcontroller\b/.test(lower)) return 'controller';
  if (/\b(model|entity|table|schema)\b/.test(lower)) return 'model';
  if (/\bmigration\b/.test(lower)) return 'migration';
  if (/\bmiddleware\b/.test(lower)) return 'middleware';
  if (/\b(command|cli|console)\b/.test(lower)) return 'command';
  if (/\b(job|queue|worker|task)\b/.test(lower)) return 'job';
  if (/\bevent\b/.test(lower)) return 'event';
  if (/\blistener\b/.test(lower)) return 'listener';
  if (/\b(view|template|blade)\b/.test(lower)) return 'view';
  if (/\bpage\b/.test(lower)) return 'page';
  if (/\bcomponent\b/.test(lower)) return 'component';
  if (/\bservice\b/.test(lower)) return 'service';
  if (/\btest\b/.test(lower)) return 'test';
  return 'unknown';
}

// ═══════════════════════════════════════════════════════════════════
// FRAMEWORK RULES
// ═══════════════════════════════════════════════════════════════════

interface FrameworkRule {
  framework: string;
  match: (kind: FeatureKind, lower: string, ctx: InsertionContext) => InsertionPoint[];
}

const FRAMEWORK_RULES: FrameworkRule[] = [
  // ─── Laravel ───────────────────────────────────────────────────
  {
    framework: 'laravel',
    match: (kind) => {
      if (kind === 'endpoint' || kind === 'route') {
        return [
          {
            file: 'routes/api.php',
            after_symbol: 'Route::',
            framework: 'laravel',
            reason: 'Laravel convention: API routes live in routes/api.php',
            scaffold_hint:
              "Add Route::method('/path', [Controller::class, 'action']); then create the controller method, FormRequest validator, and feature test",
            related_files: ['app/Http/Controllers/', 'app/Http/Requests/', 'tests/Feature/'],
          },
        ];
      }
      if (kind === 'controller') {
        return [
          {
            file: 'app/Http/Controllers/',
            framework: 'laravel',
            reason: 'Laravel convention: controllers live under app/Http/Controllers/',
            scaffold_hint:
              'php artisan make:controller NameController --resource (or extend an existing controller)',
            related_files: ['routes/api.php', 'routes/web.php'],
          },
        ];
      }
      if (kind === 'model' || kind === 'migration') {
        return [
          {
            file: 'app/Models/',
            framework: 'laravel',
            reason: 'Laravel convention: Eloquent models live under app/Models/',
            scaffold_hint: 'php artisan make:model Name -m (creates model + migration)',
            related_files: ['database/migrations/', 'database/factories/', 'database/seeders/'],
          },
        ];
      }
      if (kind === 'command') {
        return [
          {
            file: 'app/Console/Commands/',
            framework: 'laravel',
            reason: 'Laravel convention: artisan commands live under app/Console/Commands/',
            scaffold_hint: 'php artisan make:command NameCommand',
            related_files: ['app/Console/Kernel.php'],
          },
        ];
      }
      if (kind === 'job') {
        return [
          {
            file: 'app/Jobs/',
            framework: 'laravel',
            reason: 'Laravel convention: queueable jobs live under app/Jobs/',
            scaffold_hint: 'php artisan make:job NameJob (implements ShouldQueue)',
            related_files: ['config/queue.php'],
          },
        ];
      }
      if (kind === 'middleware') {
        return [
          {
            file: 'app/Http/Middleware/',
            framework: 'laravel',
            reason: 'Laravel convention: HTTP middleware lives under app/Http/Middleware/',
            scaffold_hint:
              'php artisan make:middleware NameMiddleware; register in app/Http/Kernel.php',
            related_files: ['app/Http/Kernel.php'],
          },
        ];
      }
      return [];
    },
  },

  // ─── NestJS ────────────────────────────────────────────────────
  {
    framework: 'nestjs',
    match: (kind) => {
      if (kind === 'endpoint' || kind === 'route' || kind === 'controller') {
        return [
          {
            file: 'src/',
            framework: 'nestjs',
            reason:
              'NestJS convention: feature module = controller + service + DTO under src/<feature>/',
            scaffold_hint: 'nest g module name && nest g controller name && nest g service name',
            related_files: ['src/app.module.ts'],
          },
        ];
      }
      if (kind === 'service') {
        return [
          {
            file: 'src/',
            framework: 'nestjs',
            reason: 'NestJS convention: providers/services co-located with their module',
            scaffold_hint: 'nest g service name (and inject into the relevant module)',
            related_files: [],
          },
        ];
      }
      return [];
    },
  },

  // ─── Express / Fastify / Hono ──────────────────────────────────
  {
    framework: 'express',
    match: (kind) => {
      if (kind === 'endpoint' || kind === 'route') {
        return [
          {
            file: 'routes/',
            framework: 'express',
            reason: 'Express convention: routes typically live under routes/ or src/routes/',
            scaffold_hint:
              "router.method('/path', handler); mount the router in the app entry point",
            related_files: ['src/app.ts', 'src/server.ts', 'src/index.ts', 'middleware/'],
          },
        ];
      }
      if (kind === 'middleware') {
        return [
          {
            file: 'middleware/',
            framework: 'express',
            reason: 'Express convention: middleware under middleware/ or src/middleware/',
            scaffold_hint: 'export function name(req, res, next) { ... }',
            related_files: ['src/app.ts'],
          },
        ];
      }
      return [];
    },
  },
  {
    framework: 'fastify',
    match: (kind) => {
      if (kind === 'endpoint' || kind === 'route') {
        return [
          {
            file: 'routes/',
            framework: 'fastify',
            reason: 'Fastify convention: routes registered as plugins under routes/ or src/routes/',
            scaffold_hint:
              "export default async function (fastify) { fastify.method('/path', { schema }, handler); }",
            related_files: ['src/server.ts', 'plugins/'],
          },
        ];
      }
      return [];
    },
  },
  {
    framework: 'hono',
    match: (kind) => {
      if (kind === 'endpoint' || kind === 'route') {
        return [
          {
            file: 'src/',
            framework: 'hono',
            reason: 'Hono convention: routes attached to the app instance in src/',
            scaffold_hint: "app.method('/path', (c) => c.json(...))",
            related_files: ['src/index.ts'],
          },
        ];
      }
      return [];
    },
  },

  // ─── Django / DRF / FastAPI / Flask ─────────────────────────────
  {
    framework: 'django',
    match: (kind) => {
      if (kind === 'endpoint' || kind === 'view') {
        return [
          {
            file: 'views.py',
            framework: 'django',
            reason:
              'Django convention: HTTP views live in <app>/views.py and are wired in <app>/urls.py',
            scaffold_hint: 'def view(request): ...; then add a path() entry in urls.py',
            related_files: ['urls.py', 'templates/'],
          },
        ];
      }
      if (kind === 'model' || kind === 'migration') {
        return [
          {
            file: 'models.py',
            framework: 'django',
            reason: 'Django convention: ORM models in <app>/models.py; migrations auto-generated',
            scaffold_hint: 'class Name(models.Model): ...; run python manage.py makemigrations',
            related_files: ['migrations/', 'admin.py'],
          },
        ];
      }
      return [];
    },
  },
  {
    framework: 'drf',
    match: (kind) => {
      if (kind === 'endpoint' || kind === 'view') {
        return [
          {
            file: 'views.py',
            framework: 'drf',
            reason:
              'Django REST Framework convention: ViewSets in views.py registered via routers in urls.py',
            scaffold_hint:
              'class NameViewSet(viewsets.ModelViewSet): ...; register with router in urls.py',
            related_files: ['urls.py', 'serializers.py'],
          },
        ];
      }
      return [];
    },
  },
  {
    framework: 'fastapi',
    match: (kind) => {
      if (kind === 'endpoint' || kind === 'route') {
        return [
          {
            file: 'main.py',
            framework: 'fastapi',
            reason: 'FastAPI convention: routes via @app.method or APIRouter mounted in main.py',
            scaffold_hint:
              "@router.method('/path') async def handler(...): ...; include router in main.py",
            related_files: ['routers/', 'schemas.py'],
          },
        ];
      }
      return [];
    },
  },
  {
    framework: 'flask',
    match: (kind) => {
      if (kind === 'endpoint' || kind === 'route' || kind === 'view') {
        return [
          {
            file: 'app.py',
            framework: 'flask',
            reason: 'Flask convention: routes via @app.route or Blueprints',
            scaffold_hint: "@bp.route('/path', methods=[...]) def handler(): ...",
            related_files: ['blueprints/'],
          },
        ];
      }
      return [];
    },
  },

  // ─── Rails ─────────────────────────────────────────────────────
  {
    framework: 'rails',
    match: (kind) => {
      if (kind === 'endpoint' || kind === 'route' || kind === 'controller') {
        return [
          {
            file: 'config/routes.rb',
            framework: 'rails',
            reason:
              'Rails convention: routes in config/routes.rb, controllers under app/controllers/',
            scaffold_hint: 'rails generate controller Name action; add route in config/routes.rb',
            related_files: ['app/controllers/', 'app/views/', 'test/controllers/'],
          },
        ];
      }
      if (kind === 'model') {
        return [
          {
            file: 'app/models/',
            framework: 'rails',
            reason: 'Rails convention: ActiveRecord models under app/models/',
            scaffold_hint: 'rails generate model Name field:type (creates model + migration)',
            related_files: ['db/migrate/'],
          },
        ];
      }
      return [];
    },
  },

  // ─── Spring ────────────────────────────────────────────────────
  {
    framework: 'spring',
    match: (kind) => {
      if (kind === 'endpoint' || kind === 'controller') {
        return [
          {
            file: 'src/main/java/',
            framework: 'spring',
            reason: 'Spring convention: @RestController classes under src/main/java/<package>/',
            scaffold_hint:
              '@RestController class with @GetMapping/@PostMapping methods; add Service + Repository as needed',
            related_files: [],
          },
        ];
      }
      return [];
    },
  },

  // ─── Next.js / Nuxt ────────────────────────────────────────────
  {
    framework: 'nextjs',
    match: (kind) => {
      if (kind === 'page') {
        return [
          {
            file: 'app/',
            framework: 'nextjs',
            reason:
              'Next.js App Router convention: pages live as page.tsx files under app/<route>/',
            scaffold_hint: 'Create app/<route>/page.tsx (server component by default)',
            related_files: ['app/layout.tsx'],
          },
        ];
      }
      if (kind === 'endpoint' || kind === 'route') {
        return [
          {
            file: 'app/api/',
            framework: 'nextjs',
            reason: 'Next.js convention: API routes as route.ts handlers under app/api/<path>/',
            scaffold_hint:
              'export async function GET/POST(req: Request) { ... } in app/api/<name>/route.ts',
            related_files: [],
          },
        ];
      }
      if (kind === 'component') {
        return [
          {
            file: 'components/',
            framework: 'nextjs',
            reason: 'Next.js convention: shared components under components/ or app/_components/',
            scaffold_hint: 'Create a .tsx file exporting a named component',
            related_files: [],
          },
        ];
      }
      return [];
    },
  },
  {
    framework: 'nuxt',
    match: (kind) => {
      if (kind === 'page') {
        return [
          {
            file: 'pages/',
            framework: 'nuxt',
            reason: 'Nuxt convention: file-based routing under pages/',
            scaffold_hint: 'Create pages/<name>.vue with <script setup> + <template>',
            related_files: ['layouts/'],
          },
        ];
      }
      if (kind === 'endpoint' || kind === 'route') {
        return [
          {
            file: 'server/api/',
            framework: 'nuxt',
            reason: 'Nuxt convention: server API handlers under server/api/',
            scaffold_hint: 'export default defineEventHandler(async (event) => { ... })',
            related_files: [],
          },
        ];
      }
      return [];
    },
  },

  // ─── React (generic, no Next/Nuxt) ─────────────────────────────
  {
    framework: 'react',
    match: (kind) => {
      if (kind === 'component') {
        return [
          {
            file: 'src/components/',
            framework: 'react',
            reason: 'React convention: components under src/components/',
            scaffold_hint: 'Create a .tsx file exporting a named function component',
            related_files: [],
          },
        ];
      }
      return [];
    },
  },

  // ─── Vue ───────────────────────────────────────────────────────
  {
    framework: 'vue-framework',
    match: (kind) => {
      if (kind === 'component' || kind === 'page') {
        return [
          {
            file: 'src/components/',
            framework: 'vue',
            reason: 'Vue convention: SFCs under src/components/ or src/views/',
            scaffold_hint: 'Create a .vue file with <script setup>, <template>, <style>',
            related_files: ['src/router/'],
          },
        ];
      }
      return [];
    },
  },
];
