#!/usr/bin/env node
// scripts/release.mjs
//
// Orchestrates the md-redline release flow:
// preflight → tests → compute version → generate notes → confirm/edit
// → bump → publish → push → create release.
//
// Spec: docs/superpowers/specs/2026-04-07-release-notes-review-design.md
//
// Dev escape hatch: set RELEASE_SKIP_E2E=1 to skip the slow Playwright
// suite during local iteration. Real releases never set this.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

const VALID_TYPES = new Set(['patch', 'minor', 'major']);

/**
 * Thrown when the user aborts at the confirm prompt. Distinct from other
 * errors so main()'s catch block can exit cleanly without printing a stack.
 */
class AbortRelease extends Error {
  constructor(message = 'Aborted by user') {
    super(message);
    this.name = 'AbortRelease';
  }
}

/**
 * Thrown when gh release create fails AFTER npm publish + git push succeeded.
 * The notes file must be preserved so the user's recovery command works.
 */
class ReleaseCreateFailed extends Error {
  constructor(version, notesPath, cause) {
    super(`gh release create failed: ${cause.message}`);
    this.name = 'ReleaseCreateFailed';
    this.version = version;
    this.notesPath = notesPath;
  }
}

/**
 * Run a subprocess with inherited stdio. Throws on non-zero exit.
 * Use `capture: true` to capture stdout instead of inheriting it
 * (for cases where we need to parse the output, e.g. JSON from gh api).
 */
function run(cmd, args, { capture = false, cwd = PROJECT_ROOT } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
  });
  if (result.error) {
    throw new Error(`Failed to spawn ${cmd}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with code ${result.status}`);
  }
  return capture ? result.stdout : undefined;
}

function parseArgs() {
  const type = process.argv[2];
  if (!VALID_TYPES.has(type)) {
    console.error(`Usage: node scripts/release.mjs <patch|minor|major>`);
    console.error(`Got: ${type ?? '(nothing)'}`);
    process.exit(1);
  }
  return type;
}

function preflight() {
  console.log('→ Preflight checks');

  // npm logged in
  try {
    run('npm', ['whoami'], { capture: true });
  } catch {
    throw new Error('npm whoami failed. Run `npm login` and retry.');
  }

  // gh authenticated
  try {
    run('gh', ['auth', 'status'], { capture: true });
  } catch {
    throw new Error('gh auth status failed. Run `gh auth login` and retry.');
  }

  // On main branch
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { capture: true }).trim();
  if (branch !== 'main') {
    throw new Error(`Releases must run from main, currently on '${branch}'.`);
  }

  // Clean working tree (porcelain output is empty when clean; ignored files are excluded by default)
  const status = run('git', ['status', '--porcelain'], { capture: true });
  if (status.trim() !== '') {
    console.error('Working tree is dirty:');
    run('git', ['status', '--short']);
    throw new Error('Commit or stash changes before releasing.');
  }

  console.log('  ✓ npm logged in');
  console.log('  ✓ gh authenticated');
  console.log('  ✓ on main branch');
  console.log('  ✓ working tree clean');
}

function runTests() {
  console.log('\n→ Running unit tests');
  run('npm', ['test']);
  if (process.env.RELEASE_SKIP_E2E === '1') {
    console.log('  (skipping e2e: RELEASE_SKIP_E2E=1)');
    return;
  }
  console.log('\n→ Running e2e tests');
  run('npm', ['run', 'test:e2e']);
}

function readPackageVersion() {
  const pkgPath = join(PROJECT_ROOT, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  return pkg.version;
}

function computeNextVersion(type) {
  const current = readPackageVersion();
  const parts = current.split('.').map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(
      `Cannot bump version '${current}'. ` +
      `release.mjs only handles plain X.Y.Z. ` +
      `If you're shipping a prerelease, do it manually or extend the script.`
    );
  }
  const [major, minor, patch] = parts;
  switch (type) {
    case 'patch': return `${major}.${minor}.${patch + 1}`;
    case 'minor': return `${major}.${minor + 1}.0`;
    case 'major': return `${major + 1}.0.0`;
    default: throw new Error(`Unknown bump type: ${type}`);
  }
}

function notesFilePath(version) {
  return join(PROJECT_ROOT, `.release-notes-v${version}.md`);
}

function generateNotes(currentVersion, nextVersion) {
  console.log(`\n→ Generating release notes for v${nextVersion}`);
  const body = JSON.stringify({
    tag_name: `v${nextVersion}`,
    previous_tag_name: `v${currentVersion}`,
    target_commitish: 'HEAD',
  });
  // gh api with --input - reads JSON from stdin. We use spawnSync directly
  // here (not run()) so we can pass the JSON via stdin AND capture stdout.
  const result = spawnSync(
    'gh',
    ['api', '-X', 'POST', 'repos/{owner}/{repo}/releases/generate-notes', '--input', '-'],
    {
      cwd: PROJECT_ROOT,
      input: body,
      stdio: ['pipe', 'pipe', 'inherit'],
      encoding: 'utf8',
    }
  );
  if (result.error) {
    throw new Error(`Failed to spawn gh: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`gh api releases/generate-notes exited with code ${result.status}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (e) {
    throw new Error(`Failed to parse gh api response as JSON: ${e.message}`);
  }
  if (typeof parsed.body !== 'string') {
    throw new Error(`gh api response missing 'body' field`);
  }
  const path = notesFilePath(nextVersion);
  writeFileSync(path, parsed.body, 'utf8');
  console.log(`  ✓ Wrote ${path}`);
  return path;
}

function printNotes(filePath, version) {
  const contents = readFileSync(filePath, 'utf8');
  const rule = '─'.repeat(60);
  console.log(`\nRelease notes for v${version}:`);
  console.log(rule);
  console.log(contents);
  console.log(rule);
}

function openInEditor(filePath) {
  const editor = process.env.EDITOR || 'vi';
  // Editor is run via shell so $EDITOR can include flags (e.g. "code --wait").
  // Inheriting stdio gives the editor full terminal control.
  const result = spawnSync(`${editor} "${filePath}"`, {
    stdio: 'inherit',
    shell: true,
  });
  return result.status === 0;
}

/**
 * Print + prompt loop. SIGINT support is wired via an AbortController:
 * the caller wires SIGINT to ac.abort(), readline/promises.question
 * accepts a `signal` option and rejects with AbortError when aborted.
 * Throwing from a process SIGINT handler does NOT propagate to awaited
 * code — it causes an uncaughtException and skips finally blocks.
 * The signal pattern is the canonical way to make Ctrl+C cooperative.
 */
async function confirmOrEdit(filePath, version, signal) {
  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      printNotes(filePath, version);
      let answer;
      try {
        const raw = await rl.question('[y] ship  [e] edit  [a] abort  > ', { signal });
        answer = raw.trim().toLowerCase();
      } catch (e) {
        if (e.name === 'AbortError') {
          throw new AbortRelease('Aborted by SIGINT');
        }
        throw e;
      }
      if (answer === 'y') {
        return;
      }
      if (answer === 'e') {
        const ok = openInEditor(filePath);
        if (!ok) {
          console.log('(editor exited non-zero; re-prompting)');
        }
        continue;
      }
      if (answer === 'a') {
        throw new AbortRelease();
      }
      console.log(`Unrecognized: '${answer}'. Use y, e, or a.`);
    }
  } finally {
    rl.close();
  }
}

function createRelease(version, notesPath) {
  console.log('\n→ Creating GitHub release');
  run('gh', ['release', 'create', `v${version}`, '--notes-file', notesPath]);
}

function printPublishRecovery(stage, version) {
  console.error('\n─────────────────────────────────────');
  console.error('RELEASE FAILED MID-FLIGHT');
  console.error('─────────────────────────────────────');
  switch (stage) {
    case 'version':
      console.error(`'npm version' failed. No state changed. Safe to retry.`);
      break;
    case 'publish':
      console.error(`'npm publish' failed AFTER 'npm version' created a local commit and tag.`);
      console.error(`To roll back:`);
      console.error(`  git reset --hard HEAD~1`);
      console.error(`  git tag -d v${version}`);
      break;
    case 'push':
      console.error(`'git push' failed AFTER 'npm publish' succeeded.`);
      console.error(`The package is on npm but main has not been pushed.`);
      console.error(`To recover:`);
      console.error(`  git push && git push --tags`);
      break;
    case 'push-tags':
      console.error(`'git push --tags' failed AFTER 'git push' succeeded.`);
      console.error(`Commit is pushed but the tag is not.`);
      console.error(`To recover:`);
      console.error(`  git push --tags`);
      break;
  }
  console.error('─────────────────────────────────────');
}

async function main() {
  const type = parseArgs();
  console.log(`md-redline release: ${type}\n`);

  preflight();
  runTests();

  const currentVersion = readPackageVersion();
  const nextVersion = computeNextVersion(type);
  console.log(`\n→ Current: v${currentVersion}, next: v${nextVersion}`);

  const notesPath = generateNotes(currentVersion, nextVersion);

  // SIGINT during the prompt: AbortController + signal option on rl.question.
  // SIGINT during spawnSync: the signal is delivered to the child process,
  // which exits non-zero, our run() throws, finally cleans up. No extra
  // handling needed there. Throwing from a SIGINT handler does NOT propagate
  // to awaited code, which is why we use the AbortController pattern.
  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process.once('SIGINT', onSigint);

  let preserveNotes = false;
  try {
    await confirmOrEdit(notesPath, nextVersion, ac.signal);

    // Point of no return.
    let publishStage;
    try {
      publishStage = 'version';
      run('npm', ['version', type]);
      publishStage = 'publish';
      run('npm', ['publish']);
      publishStage = 'push';
      run('git', ['push']);
      publishStage = 'push-tags';
      run('git', ['push', '--tags']);
    } catch (e) {
      printPublishRecovery(publishStage, nextVersion);
      throw e;
    }

    try {
      createRelease(nextVersion, notesPath);
    } catch (e) {
      preserveNotes = true;
      throw new ReleaseCreateFailed(nextVersion, notesPath, e);
    }

    console.log(`\n✓ Released v${nextVersion}`);
  } finally {
    process.off('SIGINT', onSigint);
    if (!preserveNotes && existsSync(notesPath)) {
      unlinkSync(notesPath);
    }
  }
}

try {
  await main();
} catch (e) {
  if (e instanceof AbortRelease) {
    console.error(`\n${e.message}`);
    process.exit(1);
  }
  if (e instanceof ReleaseCreateFailed) {
    console.error('\n─────────────────────────────────────');
    console.error('PUBLISHED BUT GITHUB RELEASE NOT CREATED');
    console.error('─────────────────────────────────────');
    console.error(`v${e.version} is on npm and pushed to git, but the GitHub release was not created.`);
    console.error(`To create it manually:`);
    console.error(`  gh release create v${e.version} --notes-file ${e.notesPath}`);
    console.error('─────────────────────────────────────');
    process.exit(1);
  }
  console.error(`\nError: ${e.message}`);
  process.exit(1);
}
