/**
 * Tests for laravel/socialite extraction.
 */
import { describe, it, expect } from 'vitest';
import {
  extractSocialiteUsage,
  buildSocialiteEdges,
} from '../../../src/indexer/plugins/integration/framework/laravel/socialite.js';

// ─── Controller with Socialite ───────────────────────────────

const CONTROLLER_SOURCE = `<?php

namespace App\\Http\\Controllers\\Auth;

use Laravel\\Socialite\\Facades\\Socialite;

class SocialAuthController extends Controller
{
    public function redirectToGithub()
    {
        return Socialite::driver('github')->redirect();
    }

    public function handleGithubCallback()
    {
        $user = Socialite::driver('github')->user();
        // handle user
    }

    public function redirectToGoogle()
    {
        return Socialite::driver('google')->scopes(['profile', 'email'])->redirect();
    }

    public function handleGoogleCallback()
    {
        $user = Socialite::driver('google')->stateless()->user();
    }
}`;

describe('socialite — controller extraction', () => {
  const info = extractSocialiteUsage(CONTROLLER_SOURCE, 'app/Http/Controllers/Auth/SocialAuthController.php');

  it('detects Socialite usage', () => {
    expect(info).not.toBeNull();
  });

  it('extracts all provider usages', () => {
    expect(info!.providers.length).toBeGreaterThanOrEqual(4);
  });

  it('detects github provider with redirect', () => {
    const githubRedirect = info!.providers.find(p => p.name === 'github' && p.usageType === 'redirect');
    expect(githubRedirect).toBeDefined();
  });

  it('detects github provider with callback', () => {
    const githubCallback = info!.providers.find(p => p.name === 'github' && p.usageType === 'callback');
    expect(githubCallback).toBeDefined();
  });

  it('detects google provider with scopes', () => {
    const googleScopes = info!.providers.find(p => p.name === 'google' && p.usageType === 'scopes');
    expect(googleScopes).toBeDefined();
  });

  it('detects google provider with stateless', () => {
    const googleStateless = info!.providers.find(p => p.name === 'google' && p.usageType === 'stateless');
    expect(googleStateless).toBeDefined();
  });

  it('captures line numbers', () => {
    for (const p of info!.providers) {
      expect(p.line).toBeGreaterThan(0);
    }
  });

  it('builds edges', () => {
    const edges = buildSocialiteEdges(info!, 'app/Http/Controllers/Auth/SocialAuthController.php');
    expect(edges.length).toBeGreaterThanOrEqual(4);
    const githubEdge = edges.find(e => e.metadata.provider === 'github');
    expect(githubEdge).toBeDefined();
    expect(githubEdge!.edgeType).toBe('socialite_uses_provider');
  });
});

// ─── Custom provider ─────────────────────────────────────────

const CUSTOM_PROVIDER_SOURCE = `<?php

namespace App\\Socialite;

use SocialiteProviders\\Manager\\OAuth2\\AbstractProvider;

class BitbucketProvider extends AbstractProvider
{
    const IDENTIFIER = 'bitbucket';

    protected function getAuthUrl($state)
    {
        return 'https://bitbucket.org/site/oauth2/authorize';
    }

    protected function getTokenUrl()
    {
        return 'https://bitbucket.org/site/oauth2/access_token';
    }

    protected function getUserByToken($token)
    {
        // ...
    }
}`;

describe('socialite — custom provider', () => {
  const info = extractSocialiteUsage(CUSTOM_PROVIDER_SOURCE, 'app/Socialite/BitbucketProvider.php');

  it('detects custom provider', () => {
    expect(info).not.toBeNull();
    expect(info!.customProviders).toHaveLength(1);
  });

  it('extracts provider class and FQN', () => {
    expect(info!.customProviders[0].className).toBe('BitbucketProvider');
    expect(info!.customProviders[0].fqn).toBe('App\\Socialite\\BitbucketProvider');
  });

  it('extracts provider name from IDENTIFIER', () => {
    expect(info!.customProviders[0].providerName).toBe('bitbucket');
  });

  it('builds custom provider edges', () => {
    const edges = buildSocialiteEdges(info!, 'app/Socialite/BitbucketProvider.php');
    const customEdge = edges.find(e => e.edgeType === 'socialite_custom_provider');
    expect(customEdge).toBeDefined();
    expect(customEdge!.metadata.providerName).toBe('bitbucket');
  });
});

// ─── No Socialite ────────────────────────────────────────────

describe('socialite — no usage', () => {
  it('returns null for file without Socialite', () => {
    const source = `<?php\nnamespace App\\Http\\Controllers;\nclass HomeController { public function index() {} }`;
    expect(extractSocialiteUsage(source, 'app/Http/Controllers/HomeController.php')).toBeNull();
  });
});
