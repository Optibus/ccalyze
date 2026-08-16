#!/usr/bin/env node
/**
 * Build the self-contained skill bundle that ships inside the plugin.
 *
 * ccalyze has zero runtime dependencies, so the whole tool is ~56KB of plain JS
 * that runs on the Node every Claude Code user already has. That means the skill
 * can ship the compiled files directly — no clone, no npm install, no `npm link`.
 *
 * Output: skills/ccalyze/ — COMMITTED to git: plugin installs are plain clones
 * with no build step, so the compiled bundle must live in the repo. Re-run this
 * script after changing src/ or SKILL.md, and commit the result.
 *
 * Layout:
 *   SKILL.md            copied from the repo-root SKILL.md (source of truth)
 *   bin/*.js            compiled, dependency-free
 *   bin/package.json    {"type":"module"} — the built files are ESM, and without
 *                       this Node would treat a bare .js as CommonJS and fail.
 *
 * Verifies the bundle by running it before declaring success — a bundle that
 * cannot execute must never be committed.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, copyFileSync, writeFileSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = resolve(root, 'build');
const out = resolve(root, 'skills', 'ccalyze');
const bin = resolve(out, 'bin');

// Clean compile: tsc never deletes outputs of removed/renamed src files, and the
// copy loop below takes every build/*.js — a stale build/ would ship orphans.
rmSync(build, { recursive: true, force: true });

console.log('· compiling');
execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });

rmSync(out, { recursive: true, force: true });
mkdirSync(bin, { recursive: true });

// Only the runnable JS — declarations and source maps are dead weight in a bundle.
const js = readdirSync(build).filter((f) => f.endsWith('.js'));
if (js.length === 0) throw new Error('no compiled JS found in build/ — did tsc run?');
for (const f of js) copyFileSync(resolve(build, f), resolve(bin, f));

writeFileSync(resolve(bin, 'package.json'), '{"type":"module"}\n');
// cli.js has a shebang and is symlinked onto PATH by /ccalyze:install-cli; the exec
// bit must be in the committed blob or every plugin update checks out a 644 copy.
chmodSync(resolve(bin, 'cli.js'), 0o755);
copyFileSync(resolve(root, 'SKILL.md'), resolve(out, 'SKILL.md'));

// Smoke test: the bundle must actually run, standalone, from an unrelated cwd.
const cli = resolve(bin, 'cli.js');
const version = execFileSync('node', [cli, '--version'], { cwd: '/', encoding: 'utf8' }).trim();
const pkgVersion = JSON.parse(
  execFileSync('node', ['-p', 'JSON.stringify(require("./package.json"))'], {
    cwd: root,
    encoding: 'utf8',
  }),
).version;
if (version !== pkgVersion) {
  throw new Error(`bundle reports ${version} but package.json says ${pkgVersion}`);
}
// And it must produce real output, not just answer --version.
const probe = JSON.parse(execFileSync('node', [cli, 'today', '--json'], { cwd: '/', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
if (!probe.summary || typeof probe.summary.totalCostUSD !== 'number') {
  throw new Error('bundle ran but produced no usable summary');
}

const files = [
  ...readdirSync(out).filter((f) => statSync(resolve(out, f)).isFile()).map((f) => [f, resolve(out, f)]),
  ...readdirSync(bin).map((f) => [`bin/${f}`, resolve(bin, f)]),
];
const total = files.reduce((n, [, p]) => n + statSync(p).size, 0);

console.log(`\n✓ skills/ccalyze/ — v${version}, ${files.length} files, ${(total / 1024).toFixed(1)}KB`);
for (const [name, p] of files) {
  console.log(`    ${name.padEnd(22)} ${String(statSync(p).size).padStart(6)}B`);
}
console.log('\n  verified: runs standalone (no install, no clone, zero deps)');
