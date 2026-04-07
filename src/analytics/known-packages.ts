/**
 * Known packages catalog — maps popular dependencies to categories,
 * priority levels, and trace-mcp plugin coverage.
 */

export interface PackageMeta {
  category: 'framework' | 'orm' | 'ui' | 'testing' | 'infra' | 'utility';
  priority: 'high' | 'medium' | 'low' | 'none';
  plugin: string | null; // trace-mcp plugin that covers this, or null
}

export const KNOWN_PACKAGES: Record<string, PackageMeta> = {
  // --- PHP / Composer ---
  'laravel/framework':              { category: 'framework', priority: 'high',   plugin: 'laravel' },
  'laravel/horizon':                { category: 'infra',     priority: 'high',   plugin: 'laravel' },
  'laravel/nova':                   { category: 'ui',        priority: 'high',   plugin: 'nova' },
  'laravel/sanctum':                { category: 'framework', priority: 'medium', plugin: 'laravel' },
  'laravel/passport':               { category: 'framework', priority: 'medium', plugin: 'laravel' },
  'laravel/cashier':                { category: 'infra',     priority: 'medium', plugin: 'laravel' },
  'laravel/scout':                  { category: 'infra',     priority: 'medium', plugin: 'laravel' },
  'laravel/socialite':              { category: 'framework', priority: 'low',    plugin: 'laravel' },
  'laravel/telescope':              { category: 'infra',     priority: 'low',    plugin: null },
  'livewire/livewire':              { category: 'ui',        priority: 'high',   plugin: 'livewire' },
  'inertiajs/inertia-laravel':      { category: 'ui',        priority: 'high',   plugin: 'inertia' },
  'spatie/laravel-permission':      { category: 'framework', priority: 'medium', plugin: null },
  'spatie/laravel-medialibrary':    { category: 'orm',       priority: 'medium', plugin: null },
  'spatie/laravel-data':            { category: 'framework', priority: 'medium', plugin: 'laravel' },
  'spatie/laravel-activitylog':     { category: 'infra',     priority: 'low',    plugin: null },
  'spatie/laravel-backup':          { category: 'infra',     priority: 'none',   plugin: null },
  'barryvdh/laravel-debugbar':      { category: 'infra',     priority: 'none',   plugin: null },
  'phpunit/phpunit':                { category: 'testing',   priority: 'medium', plugin: 'testing' },
  'pestphp/pest':                   { category: 'testing',   priority: 'medium', plugin: 'testing' },
  'symfony/console':                { category: 'framework', priority: 'medium', plugin: null },
  'symfony/http-foundation':        { category: 'framework', priority: 'medium', plugin: null },

  // --- JavaScript / npm: Frameworks ---
  'express':                        { category: 'framework', priority: 'high',   plugin: 'express' },
  'fastify':                        { category: 'framework', priority: 'high',   plugin: 'fastify' },
  'hono':                           { category: 'framework', priority: 'high',   plugin: 'hono' },
  'next':                           { category: 'framework', priority: 'high',   plugin: 'nextjs' },
  'nuxt':                           { category: 'framework', priority: 'high',   plugin: 'nuxt' },
  '@nestjs/core':                   { category: 'framework', priority: 'high',   plugin: 'nestjs' },
  '@nestjs/common':                 { category: 'framework', priority: 'high',   plugin: 'nestjs' },

  // --- JavaScript / npm: UI ---
  'react':                          { category: 'ui',        priority: 'high',   plugin: 'react' },
  'vue':                            { category: 'ui',        priority: 'high',   plugin: 'vue-framework' },
  '@vue/compiler-sfc':              { category: 'ui',        priority: 'low',    plugin: 'vue-framework' },
  'svelte':                         { category: 'ui',        priority: 'high',   plugin: 'svelte' },
  'angular':                        { category: 'ui',        priority: 'high',   plugin: 'angular' },
  '@angular/core':                  { category: 'ui',        priority: 'high',   plugin: 'angular' },
  'react-native':                   { category: 'ui',        priority: 'high',   plugin: 'react-native' },
  'expo':                           { category: 'ui',        priority: 'high',   plugin: 'react-native' },
  '@nuxt/ui':                       { category: 'ui',        priority: 'high',   plugin: 'nuxt-ui' },
  '@nuxt/ui-pro':                   { category: 'ui',        priority: 'high',   plugin: 'nuxt-ui' },
  '@inertiajs/react':               { category: 'ui',        priority: 'high',   plugin: 'inertia' },
  '@inertiajs/vue3':                { category: 'ui',        priority: 'high',   plugin: 'inertia' },
  '@inertiajs/svelte':              { category: 'ui',        priority: 'high',   plugin: 'inertia' },
  'tailwindcss':                    { category: 'ui',        priority: 'medium', plugin: 'tailwindcss' },
  '@mui/material':                  { category: 'ui',        priority: 'medium', plugin: 'mui' },
  'antd':                           { category: 'ui',        priority: 'medium', plugin: 'antd' },
  '@headlessui/react':              { category: 'ui',        priority: 'medium', plugin: 'headless-ui' },
  '@headlessui/vue':                { category: 'ui',        priority: 'medium', plugin: 'headless-ui' },
  '@radix-ui/react-dialog':         { category: 'ui',        priority: 'low',    plugin: null },
  'shadcn':                         { category: 'ui',        priority: 'medium', plugin: 'shadcn' },

  // --- JavaScript / npm: State management ---
  'zustand':                        { category: 'ui',        priority: 'medium', plugin: 'zustand-redux' },
  'redux':                          { category: 'ui',        priority: 'medium', plugin: 'zustand-redux' },
  '@reduxjs/toolkit':               { category: 'ui',        priority: 'medium', plugin: 'zustand-redux' },

  // --- JavaScript / npm: ORMs ---
  'prisma':                         { category: 'orm',       priority: 'high',   plugin: 'prisma' },
  '@prisma/client':                 { category: 'orm',       priority: 'high',   plugin: 'prisma' },
  'drizzle-orm':                    { category: 'orm',       priority: 'high',   plugin: 'drizzle' },
  'typeorm':                        { category: 'orm',       priority: 'high',   plugin: 'typeorm' },
  'sequelize':                      { category: 'orm',       priority: 'high',   plugin: 'sequelize' },
  'mongoose':                       { category: 'orm',       priority: 'high',   plugin: 'mongoose' },
  'knex':                           { category: 'orm',       priority: 'medium', plugin: 'raw-sql' },
  'kysely':                         { category: 'orm',       priority: 'medium', plugin: 'raw-sql' },

  // --- JavaScript / npm: DB drivers (raw-sql plugin) ---
  'better-sqlite3':                 { category: 'orm',       priority: 'medium', plugin: 'raw-sql' },
  'sqlite3':                        { category: 'orm',       priority: 'medium', plugin: 'raw-sql' },
  'sql.js':                         { category: 'orm',       priority: 'medium', plugin: 'raw-sql' },
  'pg':                             { category: 'orm',       priority: 'medium', plugin: 'raw-sql' },
  'mysql2':                         { category: 'orm',       priority: 'medium', plugin: 'raw-sql' },
  'mysql':                          { category: 'orm',       priority: 'medium', plugin: 'raw-sql' },
  'tedious':                        { category: 'orm',       priority: 'medium', plugin: 'raw-sql' },
  'oracledb':                       { category: 'orm',       priority: 'medium', plugin: 'raw-sql' },

  // --- JavaScript / npm: API ---
  '@trpc/server':                   { category: 'framework', priority: 'high',   plugin: 'trpc' },
  '@trpc/client':                   { category: 'framework', priority: 'high',   plugin: 'trpc' },
  'graphql':                        { category: 'framework', priority: 'high',   plugin: 'graphql' },
  '@apollo/server':                 { category: 'framework', priority: 'high',   plugin: 'graphql' },
  '@apollo/client':                 { category: 'framework', priority: 'high',   plugin: 'graphql' },
  '@modelcontextprotocol/sdk':      { category: 'framework', priority: 'high',   plugin: 'mcp-sdk' },

  // --- JavaScript / npm: Validation ---
  'zod':                            { category: 'framework', priority: 'medium', plugin: 'zod' },
  'yup':                            { category: 'framework', priority: 'medium', plugin: null },
  'joi':                            { category: 'framework', priority: 'medium', plugin: null },

  // --- JavaScript / npm: Data fetching ---
  '@tanstack/react-query':          { category: 'ui',        priority: 'medium', plugin: 'data-fetching' },
  'swr':                            { category: 'ui',        priority: 'medium', plugin: 'data-fetching' },

  // --- JavaScript / npm: Realtime ---
  'socket.io':                      { category: 'infra',     priority: 'high',   plugin: 'socketio' },
  'socket.io-client':               { category: 'infra',     priority: 'medium', plugin: 'socketio' },

  // --- JavaScript / npm: Tooling (with plugins) ---
  'commander':                      { category: 'infra',     priority: 'medium', plugin: 'commander' },
  'pino':                           { category: 'infra',     priority: 'medium', plugin: 'pino' },
  'cosmiconfig':                    { category: 'infra',     priority: 'medium', plugin: 'cosmiconfig' },
  'neverthrow':                     { category: 'infra',     priority: 'medium', plugin: 'neverthrow' },
  '@clack/prompts':                 { category: 'infra',     priority: 'medium', plugin: 'clack' },
  '@clack/core':                    { category: 'infra',     priority: 'medium', plugin: 'clack' },
  'tree-sitter':                    { category: 'infra',     priority: 'medium', plugin: 'tree-sitter' },
  'web-tree-sitter':                { category: 'infra',     priority: 'medium', plugin: 'tree-sitter' },
  'tree-sitter-wasms':              { category: 'infra',     priority: 'low',    plugin: 'tree-sitter' },
  'n8n-workflow':                   { category: 'infra',     priority: 'high',   plugin: 'n8n' },

  // --- JavaScript / npm: Build tools (with plugin) ---
  'tsup':                           { category: 'infra',     priority: 'low',    plugin: 'build-tools' },
  'esbuild':                        { category: 'infra',     priority: 'low',    plugin: 'build-tools' },
  'rollup':                         { category: 'infra',     priority: 'low',    plugin: 'build-tools' },
  'webpack':                        { category: 'infra',     priority: 'low',    plugin: 'build-tools' },
  '@rspack/core':                   { category: 'infra',     priority: 'low',    plugin: 'build-tools' },
  'vite':                           { category: 'infra',     priority: 'low',    plugin: 'build-tools' },
  'turbo':                          { category: 'infra',     priority: 'low',    plugin: 'build-tools' },
  'parcel':                         { category: 'infra',     priority: 'low',    plugin: 'build-tools' },

  // --- JavaScript / npm: Testing ---
  'vitest':                         { category: 'testing',   priority: 'medium', plugin: 'testing' },
  'jest':                           { category: 'testing',   priority: 'medium', plugin: 'testing' },
  'mocha':                          { category: 'testing',   priority: 'medium', plugin: 'testing' },
  'cypress':                        { category: 'testing',   priority: 'medium', plugin: 'testing' },
  'playwright':                     { category: 'testing',   priority: 'medium', plugin: 'testing' },
  '@playwright/test':               { category: 'testing',   priority: 'medium', plugin: 'testing' },
  '@testing-library/react':         { category: 'testing',   priority: 'medium', plugin: 'testing' },

  // --- JavaScript / npm: Infra (no plugin) ---
  'stripe':                         { category: 'infra',     priority: 'low',    plugin: null },
  'winston':                        { category: 'infra',     priority: 'low',    plugin: null },
  'bull':                           { category: 'infra',     priority: 'medium', plugin: null },
  'bullmq':                         { category: 'infra',     priority: 'medium', plugin: null },

  // --- JavaScript / npm: Utilities (no plugin, low signal) ---
  'axios':                          { category: 'utility',   priority: 'none',   plugin: null },
  'lodash':                         { category: 'utility',   priority: 'none',   plugin: null },
  'date-fns':                       { category: 'utility',   priority: 'none',   plugin: null },
  'uuid':                           { category: 'utility',   priority: 'none',   plugin: null },
  'dotenv':                         { category: 'utility',   priority: 'none',   plugin: null },
  'typescript':                     { category: 'utility',   priority: 'none',   plugin: null },

  // --- Python / pip ---
  'django':                         { category: 'framework', priority: 'high',   plugin: 'django' },
  'djangorestframework':            { category: 'framework', priority: 'high',   plugin: 'drf' },
  'django-ninja':                   { category: 'framework', priority: 'high',   plugin: null },
  'fastapi':                        { category: 'framework', priority: 'high',   plugin: 'fastapi' },
  'flask':                          { category: 'framework', priority: 'high',   plugin: 'flask' },
  'celery':                         { category: 'infra',     priority: 'high',   plugin: 'celery' },
  'sqlalchemy':                     { category: 'orm',       priority: 'high',   plugin: 'sqlalchemy' },
  'pydantic':                       { category: 'framework', priority: 'medium', plugin: 'pydantic' },
  'pytest':                         { category: 'testing',   priority: 'medium', plugin: 'testing' },
  'alembic':                        { category: 'orm',       priority: 'medium', plugin: 'sqlalchemy' },
  'tortoise-orm':                   { category: 'orm',       priority: 'medium', plugin: null },
  'psycopg2':                       { category: 'orm',       priority: 'medium', plugin: 'raw-sql' },
  'psycopg2-binary':                { category: 'orm',       priority: 'medium', plugin: 'raw-sql' },
  'pymysql':                        { category: 'orm',       priority: 'medium', plugin: 'raw-sql' },
  'asyncpg':                        { category: 'orm',       priority: 'medium', plugin: 'raw-sql' },
  'aiosqlite':                      { category: 'orm',       priority: 'medium', plugin: 'raw-sql' },

  // --- Ruby / Gemfile ---
  'rails':                          { category: 'framework', priority: 'high',   plugin: 'rails' },
  'sidekiq':                        { category: 'infra',     priority: 'high',   plugin: null },
  'devise':                         { category: 'framework', priority: 'medium', plugin: null },
  'pundit':                         { category: 'framework', priority: 'medium', plugin: null },
  'rspec':                          { category: 'testing',   priority: 'medium', plugin: 'testing' },
  'rspec-rails':                    { category: 'testing',   priority: 'medium', plugin: 'testing' },

  // --- Go ---
  'github.com/gin-gonic/gin':       { category: 'framework', priority: 'high',   plugin: 'gin' },
  'github.com/labstack/echo':       { category: 'framework', priority: 'high',   plugin: 'echo' },
  'github.com/gofiber/fiber':       { category: 'framework', priority: 'high',   plugin: null },
  'gorm.io/gorm':                   { category: 'orm',       priority: 'high',   plugin: null },

  // --- Java/Kotlin ---
  'org.springframework.boot':       { category: 'framework', priority: 'high',   plugin: 'spring' },
  'org.springframework':            { category: 'framework', priority: 'high',   plugin: 'spring' },
};
