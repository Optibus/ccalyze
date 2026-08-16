import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { VERSION } from './version.ts';

describe('VERSION', () => {
  it('matches package.json', () => {
    // The bundled skill ships without the repo's package.json, so the version is
    // embedded in source. This test keeps the two from drifting.
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(VERSION, pkg.version);
  });

  it('is a semver string', () => {
    assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  });

  it('matches the plugin manifest', () => {
    // The repo doubles as a Claude Code plugin; its manifest carries its own
    // version field. This test keeps it from drifting from package.json.
    const manifest = JSON.parse(
      readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'),
    );
    assert.equal(manifest.version, VERSION);
  });
});

describe('committed skill bundle (skills/ccalyze/)', () => {
  // The bundle is generated output committed on purpose (plugin installs are
  // plain clones with no build step). These tests fail `npm run verify` when
  // someone changes src/ or SKILL.md without re-running `npm run bundle-skill`.
  it('ships the current version', () => {
    const bundled = readFileSync(
      new URL('../skills/ccalyze/bin/version.js', import.meta.url),
      'utf8',
    );
    assert.ok(bundled.includes(`'${VERSION}'`) || bundled.includes(`"${VERSION}"`));
  });

  it('ships a SKILL.md identical to the repo-root source of truth', () => {
    const source = readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8');
    const bundled = readFileSync(new URL('../skills/ccalyze/SKILL.md', import.meta.url), 'utf8');
    assert.equal(bundled, source);
  });

  it('ships cli.js with the exec bit set', () => {
    // cli.js gets symlinked onto PATH by /ccalyze:install-cli; without the exec
    // bit in the committed blob, every plugin update checks out a 644 copy.
    const { mode } = statSync(new URL('../skills/ccalyze/bin/cli.js', import.meta.url));
    assert.ok(mode & 0o111, 'cli.js is not executable');
  });
});
