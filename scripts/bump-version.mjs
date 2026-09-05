#!/usr/bin/env node

/**
 * Bumps the version in every place it is duplicated by hand:
 *   - package.json "version"
 *   - skills/promptlog/SKILL.md frontmatter "metadata.version" line
 *   - .claude-plugin/plugin.json "version"
 *   - .codex-plugin/plugin.json "version"
 *
 * Usage: node scripts/bump-version.mjs <version>   e.g. 0.3.0
 *
 * Run this, then `git diff` to confirm all four now agree, before tagging a
 * release (see CONTRIBUTING.md "Release").
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  process.stderr.write('usage: node scripts/bump-version.mjs <version>   e.g. 0.3.0\n');
  process.exit(2);
}

/** Replaces just the top-level `"version": "..."` line in place, by regex,
 * rather than round-tripping through JSON.parse/stringify - which would
 * repaginate the whole file (e.g. re-wrapping a compact array onto several
 * lines) and turn a one-line diff into a noisy one. */
function bumpJson(relPath) {
  const full = path.join(ROOT, relPath);
  const raw = fs.readFileSync(full, 'utf-8');
  JSON.parse(raw); // fail loudly if the file isn't valid JSON to begin with
  const re = /^(\s*"version"\s*:\s*")([^"]*)(")/m;
  const m = re.exec(raw);
  if (!m) {
    process.stderr.write(`${relPath}: no top-level "version" field found\n`);
    process.exit(1);
  }
  const before = m[2];
  const updated = raw.replace(re, `$1${version}$3`);
  fs.writeFileSync(full, updated);
  process.stdout.write(`${relPath}: ${before} -> ${version}\n`);
}

function bumpSkillMd(relPath) {
  const full = path.join(ROOT, relPath);
  const raw = fs.readFileSync(full, 'utf-8');
  // `metadata.version` is an indented `  version:` line; the regex requires
  // exactly two spaces of indentation.
  const re = /^( {2}version:\s*)([0-9][^\s]*)\s*$/m;
  const m = re.exec(raw);
  if (!m) {
    process.stderr.write(`${relPath}: no "metadata.version" line found in frontmatter\n`);
    process.exit(1);
  }
  const before = m[2];
  const updated = raw.replace(re, `$1${version}`);
  fs.writeFileSync(full, updated);
  process.stdout.write(`${relPath}: ${before} -> ${version}\n`);
}

bumpJson('package.json');
bumpSkillMd(path.join('skills', 'promptlog', 'SKILL.md'));
bumpJson(path.join('.claude-plugin', 'plugin.json'));
bumpJson(path.join('.codex-plugin', 'plugin.json'));

process.stdout.write(`bump-version: all four now at ${version}\n`);
