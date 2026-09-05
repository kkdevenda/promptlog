#!/usr/bin/env node

/**
 * CI guard for skills/promptlog/SKILL.md's frontmatter against the
 * agentskills.io spec (https://agentskills.io/specification): exactly six
 * top-level keys are allowed - name, description, license, compatibility
 * (a string, max 500 chars), metadata (string -> string), allowed-tools -
 * and any other key fails packaging on hosts that validate. promptlog's own
 * version therefore lives at `metadata.version`, where src/core/version.ts
 * reads it.
 *
 * The YAML parser here is deliberately minimal: top-level `key: value` lines
 * plus one nested block of two-space-indented `key: value` lines. That is
 * all this file uses, and it keeps the check dependency-free.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SKILL_MD = path.join(__dirname, '..', 'skills', 'promptlog', 'SKILL.md');
const ALLOWED_KEYS = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

function fail(msg) {
  process.stderr.write(`check-skill: ${msg}\n`);
  process.exit(1);
}

function splitFrontmatter(raw) {
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== '---') fail('SKILL.md must start with a `---` frontmatter fence');
  const end = lines.indexOf('---', 1);
  if (end === -1) fail('frontmatter has no closing `---` fence');
  return { fm: lines.slice(1, end), body: lines.slice(end + 1).join('\n') };
}

/** Returns { top: {key: string|object}, nested: Set<key whose value is a map> }.
 * Scalars stay as their raw string (quotes stripped when the whole value is
 * quoted). A key with an empty value followed by indented lines is a map. */
function parseFrontmatter(lines) {
  const top = {};
  let current = null; // key of the nested block being filled
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const nested = /^ {2}([^\s:][^:]*):\s*(.*)$/.exec(line);
    if (nested && current) {
      const [, k, v] = nested;
      if (v === '' || /^[[{]/.test(v) || v === '|' || v === '>') {
        fail(`metadata.${k}: value must be a scalar string (got ${JSON.stringify(v)})`);
      }
      top[current][k] = unquote(v);
      continue;
    }
    if (/^\s/.test(line)) {
      fail(
        `line ${i + 2}: unexpected indentation (only a two-space nested block under a map key is supported): ${JSON.stringify(line)}`,
      );
    }
    const m = /^([^\s:][^:]*):\s*(.*)$/.exec(line);
    if (!m) fail(`line ${i + 2}: cannot parse frontmatter line ${JSON.stringify(line)}`);
    const [, key, value] = m;
    if (key in top) fail(`duplicate top-level key \`${key}\``);
    if (value === '') {
      top[key] = {};
      current = key;
    } else {
      top[key] = unquote(value);
      current = null;
    }
  }
  return top;
}

function unquote(v) {
  const s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

function isScalar(v) {
  return typeof v === 'string' && !/^[[{]/.test(v);
}

function main() {
  const raw = fs.readFileSync(SKILL_MD, 'utf-8');
  const { fm, body } = splitFrontmatter(raw);
  const top = parseFrontmatter(fm);

  for (const key of Object.keys(top)) {
    if (!ALLOWED_KEYS.includes(key)) {
      fail(
        `top-level key \`${key}\` is not allowed; agentskills.io permits only: ${ALLOWED_KEYS.join(', ')}`,
      );
    }
  }

  if (!isScalar(top.name)) fail('`name` is missing or not a string');
  if (top.name.length > 64) fail(`\`name\` is ${top.name.length} chars; max 64`);
  if (!NAME_RE.test(top.name)) fail(`\`name\` ${JSON.stringify(top.name)} must match ${NAME_RE}`);

  if (!isScalar(top.description)) fail('`description` is missing or not a string');
  if (top.description.length > 1024) fail(`\`description\` is ${top.description.length} chars; max 1024`);

  if ('compatibility' in top) {
    if (!isScalar(top.compatibility)) fail('`compatibility` must be a scalar string, not a list or map');
    if (top.compatibility.length > 500)
      fail(`\`compatibility\` is ${top.compatibility.length} chars; max 500`);
  }

  if ('license' in top && !isScalar(top.license)) fail('`license` must be a scalar string');
  if ('allowed-tools' in top && !isScalar(top['allowed-tools']))
    fail('`allowed-tools` must be a scalar string');

  if (!('metadata' in top) || typeof top.metadata !== 'object') {
    fail('`metadata` block is missing (it must carry `  version: x.y.z`)');
  }
  for (const [k, v] of Object.entries(top.metadata)) {
    if (!isScalar(v)) fail(`metadata.${k} must be a scalar string`);
  }
  if (!top.metadata.version) fail('`metadata.version` is missing');
  if (!SEMVER_RE.test(top.metadata.version))
    fail(`\`metadata.version\` ${JSON.stringify(top.metadata.version)} is not semver-shaped`);

  if (/^argument-hint:/m.test(raw))
    fail('`argument-hint:` is not an agentskills.io key; put the hint in the body instead');
  if (/^version:/m.test(raw)) fail('a top-level `version:` line is not allowed; use `metadata.version`');
  if (/^argument-hint:/m.test(body)) fail('body still mentions `argument-hint:` at column 0');

  process.stdout.write('check-skill: OK\n');
}

main();
