import { describe, expect, it } from 'vitest';
import { RailsPlugin } from '../../../src/indexer/plugins/integration/framework/rails/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

function makeCtx(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return { rootPath: '/tmp/rails-app', configFiles: ['Gemfile', 'config/routes.rb'], ...overrides };
}

describe('RailsPlugin — detection', () => {
  it('detects via Gemfile', () => {
    expect(new RailsPlugin().detect(makeCtx())).toBe(true);
  });
  it('detects via config/application.rb', () => {
    expect(new RailsPlugin().detect(makeCtx({ configFiles: ['config/application.rb'] }))).toBe(
      true,
    );
  });
  it('rejects without Rails markers', () => {
    expect(new RailsPlugin().detect(makeCtx({ configFiles: ['package.json'] }))).toBe(false);
  });
});

describe('RailsPlugin — schema', () => {
  it('registers Rails edge types', () => {
    const schema = new RailsPlugin().registerSchema();
    const names = schema.edgeTypes?.map((e) => e.name) ?? [];
    expect(names).toContain('rails_has_many');
    expect(names).toContain('rails_belongs_to');
    expect(names).toContain('rails_route');
  });
});

describe('RailsPlugin — route extraction', () => {
  it('extracts resources routes', async () => {
    const source = `
Rails.application.routes.draw do
  resources :users
  get '/about', to: 'pages#about'
end
    `;
    const plugin = new RailsPlugin();
    const result = await plugin.extractNodes!('config/routes.rb', Buffer.from(source), 'ruby');
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    // resources :users generates 6 routes + 1 get
    expect(parsed.routes!.length).toBeGreaterThanOrEqual(7);
    const uris = parsed.routes!.map((r) => r.uri);
    expect(uris).toContain('/users');
    expect(uris).toContain('/about');
  });

  it('handles namespace prefix', async () => {
    const source = `
Rails.application.routes.draw do
  namespace :api do
    resources :posts
  end
end
    `;
    const plugin = new RailsPlugin();
    const result = await plugin.extractNodes!('config/routes.rb', Buffer.from(source), 'ruby');
    expect(result.isOk()).toBe(true);
    const uris = result._unsafeUnwrap().routes!.map((r) => r.uri);
    expect(uris.some((u) => u.startsWith('/api/posts'))).toBe(true);
  });
});

describe('RailsPlugin — model extraction', () => {
  it('extracts ActiveRecord associations', async () => {
    const source = `
class User < ApplicationRecord
  has_many :posts
  has_one :profile
  belongs_to :organization
  has_and_belongs_to_many :roles
end
    `;
    const plugin = new RailsPlugin();
    const result = await plugin.extractNodes!('app/models/user.rb', Buffer.from(source), 'ruby');
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    expect(parsed.frameworkRole).toBe('model');
    const edgeTypes = parsed.edges!.map((e) => e.edgeType);
    expect(edgeTypes).toContain('rails_has_many');
    expect(edgeTypes).toContain('rails_has_one');
    expect(edgeTypes).toContain('rails_belongs_to');
    expect(edgeTypes).toContain('rails_habtm');
  });
});

describe('RailsPlugin — controller extraction', () => {
  it('extracts before_action callbacks', async () => {
    const source = `
class UsersController < ApplicationController
  before_action :authenticate_user
  before_action :set_user, only: [:show, :edit]

  def index; end
end
    `;
    const plugin = new RailsPlugin();
    const result = await plugin.extractNodes!(
      'app/controllers/users_controller.rb',
      Buffer.from(source),
      'ruby',
    );
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    expect(parsed.frameworkRole).toBe('controller');
    const callbacks = parsed.edges!.filter((e) => e.edgeType === 'rails_before_action');
    expect(callbacks.length).toBeGreaterThanOrEqual(2);
  });
});

describe('RailsPlugin — migration extraction', () => {
  it('extracts create_table migrations', async () => {
    const source = `
class CreateUsers < ActiveRecord::Migration[7.0]
  def change
    create_table :users do |t|
      t.string :name
      t.string :email
      t.timestamps
    end
  end
end
    `;
    const plugin = new RailsPlugin();
    const result = await plugin.extractNodes!(
      'db/migrate/20230101000000_create_users.rb',
      Buffer.from(source),
      'ruby',
    );
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    expect(parsed.frameworkRole).toBe('migration');
    expect(parsed.migrations!.length).toBeGreaterThanOrEqual(1);
    expect(parsed.migrations![0].tableName).toBe('users');
    expect(parsed.migrations![0].operation).toBe('create');
    expect(parsed.migrations![0].columns!.length).toBeGreaterThanOrEqual(2);
  });
});
