import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

  it('ships references/ identical to the repo-root source of truth', () => {
    // SKILL.md sends the agent here for detail on a less-common step; a stale or
    // missing copy in the bundle means that Read call fails for every real user,
    // even though this describe block's other checks stay green.
    const root = fileURLToPath(new URL('..', import.meta.url));
    const sourceDir = resolve(root, 'references');
    const bundledDir = resolve(root, 'skills', 'ccalyze', 'references');
    assert.ok(existsSync(sourceDir), 'references/ is missing at the repo root');
    assert.ok(existsSync(bundledDir), 'skills/ccalyze/references/ is missing — re-run `npm run bundle-skill`');
    const sourceFiles = readdirSync(sourceDir).filter((f) => f.endsWith('.md')).sort();
    const bundledFiles = readdirSync(bundledDir).filter((f) => f.endsWith('.md')).sort();
    assert.deepEqual(bundledFiles, sourceFiles, 'skills/ccalyze/references/ holds a different set of files');
    for (const file of sourceFiles) {
      assert.equal(
        readFileSync(resolve(bundledDir, file), 'utf8'),
        readFileSync(resolve(sourceDir, file), 'utf8'),
        `skills/ccalyze/references/${file} is stale — re-run \`npm run bundle-skill\` and commit it`,
      );
    }
  });

  it('ships JS compiled from the current src/', () => {
    // The version and SKILL.md checks above only catch a bundle left behind by a
    // *version bump* or a doc edit. A fix landed in src/ at an unchanged version
    // is the dangerous case: verify stays green while every plugin install keeps
    // running the old code — and the bundle, not build/, is what users execute.
    // So compile src/ fresh and compare byte for byte.
    const root = fileURLToPath(new URL('..', import.meta.url));
    const bundleDir = resolve(root, 'skills', 'ccalyze', 'bin');
    const fresh = mkdtempSync(resolve(tmpdir(), 'ccalyze-bundle-check-'));
    try {
      execFileSync('node', [resolve(root, 'node_modules/typescript/bin/tsc'), '--outDir', fresh], {
        cwd: root,
        stdio: 'pipe',
      });
      const compiled = readdirSync(fresh).filter((f) => f.endsWith('.js')).sort();
      const bundled = readdirSync(bundleDir).filter((f) => f.endsWith('.js')).sort();
      assert.deepEqual(
        bundled,
        compiled,
        'skills/ccalyze/bin/ holds a different set of files than a fresh compile — re-run `npm run bundle-skill`',
      );
      for (const file of compiled) {
        assert.equal(
          readFileSync(resolve(bundleDir, file), 'utf8'),
          readFileSync(resolve(fresh, file), 'utf8'),
          `skills/ccalyze/bin/${file} is stale — re-run \`npm run bundle-skill\` and commit it`,
        );
      }
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('ships cli.js with the exec bit set', () => {
    // cli.js gets symlinked onto PATH by /ccalyze:install-cli; without the exec
    // bit in the committed blob, every plugin update checks out a 644 copy.
    const { mode } = statSync(new URL('../skills/ccalyze/bin/cli.js', import.meta.url));
    assert.ok(mode & 0o111, 'cli.js is not executable');
  });
});
