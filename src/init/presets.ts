/**
 * Include/exclude pattern presets per framework and language.
 * Used by config-generator to produce smart .trace-mcp.json defaults.
 */

export interface IncludePreset {
  include: string[];
  exclude: string[];
}

/** Base excludes applied to all projects. */
export const BASE_EXCLUDE = [
  'node_modules/**', '.git/**', '**/.env', '**/.env.*',
];

/** Framework-specific presets. Keys match plugin manifest names. */
export const FRAMEWORK_PRESETS: Record<string, IncludePreset> = {
  // PHP frameworks
  laravel: {
    include: [
      'app/**/*.php', 'routes/**/*.php', 'database/migrations/**/*.php',
      'config/**/*.php', 'tests/**/*.php',
    ],
    exclude: ['vendor/**', 'storage/**', 'bootstrap/cache/**'],
  },
  django: {
    include: ['**/*.py', '**/templates/**/*.html'],
    exclude: ['venv/**', '.venv/**', '__pycache__/**', 'staticfiles/**', 'media/**'],
  },
  fastapi: {
    include: ['**/*.py'],
    exclude: ['venv/**', '.venv/**', '__pycache__/**'],
  },
  flask: {
    include: ['**/*.py', '**/templates/**/*.html'],
    exclude: ['venv/**', '.venv/**', '__pycache__/**'],
  },
  express: {
    include: ['src/**/*.{ts,tsx,js,jsx}', 'routes/**/*.{ts,js}', 'middleware/**/*.{ts,js}'],
    exclude: ['dist/**', 'build/**'],
  },
  nestjs: {
    include: ['src/**/*.ts', 'test/**/*.ts'],
    exclude: ['dist/**'],
  },
  fastify: {
    include: ['src/**/*.{ts,js}', 'routes/**/*.{ts,js}', 'plugins/**/*.{ts,js}'],
    exclude: ['dist/**', 'build/**'],
  },
  hono: {
    include: ['src/**/*.{ts,tsx,js,jsx}'],
    exclude: ['dist/**'],
  },
  nextjs: {
    include: [
      'src/**/*.{ts,tsx,js,jsx}', 'app/**/*.{ts,tsx,js,jsx}',
      'pages/**/*.{ts,tsx,js,jsx}', 'components/**/*.{ts,tsx,js,jsx}',
      'lib/**/*.{ts,tsx,js,jsx}',
    ],
    exclude: ['.next/**', 'out/**'],
  },
  nuxt: {
    include: [
      'app/**/*.{vue,ts}', 'components/**/*.vue', 'composables/**/*.ts',
      'layouts/**/*.vue', 'middleware/**/*.ts', 'pages/**/*.vue',
      'plugins/**/*.ts', 'server/**/*.ts', 'stores/**/*.ts',
    ],
    exclude: ['.nuxt/**', '.output/**'],
  },
  rails: {
    include: [
      'app/**/*.rb', 'config/**/*.rb', 'db/migrate/**/*.rb',
      'lib/**/*.rb', 'test/**/*.rb', 'spec/**/*.rb',
    ],
    exclude: ['tmp/**', 'log/**', 'public/assets/**'],
  },
  spring: {
    include: ['src/**/*.java', 'src/**/*.kt'],
    exclude: ['target/**', 'build/**', '.gradle/**'],
  },
  // ORMs
  prisma: {
    include: ['prisma/**/*.prisma'],
    exclude: [],
  },
  typeorm: {
    include: ['src/**/*.ts'],
    exclude: ['dist/**'],
  },
  drizzle: {
    include: ['src/**/*.ts', 'drizzle/**/*.ts'],
    exclude: ['dist/**'],
  },
  sequelize: {
    include: ['src/**/*.{ts,js}', 'models/**/*.{ts,js}', 'migrations/**/*.{ts,js}'],
    exclude: ['dist/**'],
  },
  mongoose: {
    include: ['src/**/*.{ts,js}', 'models/**/*.{ts,js}'],
    exclude: ['dist/**'],
  },
  sqlalchemy: {
    include: ['**/*.py'],
    exclude: ['venv/**', '.venv/**', '__pycache__/**'],
  },
  // Frontend / View
  vue: {
    include: ['src/**/*.{vue,ts,tsx,js,jsx}'],
    exclude: [],
  },
  react: {
    include: ['src/**/*.{ts,tsx,js,jsx}'],
    exclude: [],
  },
  'react-native': {
    include: ['src/**/*.{ts,tsx,js,jsx}', 'app/**/*.{ts,tsx,js,jsx}'],
    exclude: ['android/**', 'ios/**'],
  },
  inertia: {
    include: ['resources/js/**/*.{vue,ts,tsx,js,jsx}'],
    exclude: [],
  },
  blade: {
    include: ['resources/views/**/*.blade.php'],
    exclude: [],
  },
  // API
  graphql: {
    include: ['src/**/*.{ts,js,graphql,gql}'],
    exclude: [],
  },
  trpc: {
    include: ['src/**/*.ts'],
    exclude: ['dist/**'],
  },
  drf: {
    include: ['**/*.py'],
    exclude: ['venv/**', '.venv/**', '__pycache__/**'],
  },
  // Realtime
  socketio: {
    include: ['src/**/*.{ts,js}'],
    exclude: ['dist/**'],
  },
  // Tooling
  celery: {
    include: ['**/*.py'],
    exclude: ['venv/**', '.venv/**', '__pycache__/**'],
  },
  n8n: {
    include: ['**/*.json'],
    exclude: [],
  },
};

/** Language-based fallback presets (used when no frameworks detected). */
export const LANGUAGE_PRESETS: Record<string, IncludePreset> = {
  typescript: {
    include: ['src/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}', 'test/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    exclude: ['dist/**', 'build/**'],
  },
  javascript: {
    include: ['src/**/*.{js,jsx}', 'lib/**/*.{js,jsx}', 'test/**/*.{js,jsx}'],
    exclude: ['dist/**', 'build/**'],
  },
  php: {
    include: ['app/**/*.php', 'src/**/*.php', 'tests/**/*.php'],
    exclude: ['vendor/**'],
  },
  python: {
    include: ['**/*.py'],
    exclude: ['venv/**', '.venv/**', '__pycache__/**'],
  },
  go: {
    include: ['**/*.go'],
    exclude: [],
  },
  rust: {
    include: ['src/**/*.rs'],
    exclude: ['target/**'],
  },
  ruby: {
    include: ['app/**/*.rb', 'lib/**/*.rb', 'spec/**/*.rb', 'test/**/*.rb'],
    exclude: [],
  },
  java: {
    include: ['src/**/*.java'],
    exclude: ['target/**', 'build/**', '.gradle/**'],
  },
  kotlin: {
    include: ['src/**/*.kt', 'src/**/*.kts'],
    exclude: ['build/**', '.gradle/**'],
  },
};
