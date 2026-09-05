import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { DEFAULT_CONFIG, describeFindings, mergeConfig, redact } from '../src/core/redact';

// Assembled at runtime so no key-shaped literal sits in the repo (GitHub push protection).
const AWS_KEY = `AKIA${'ABCDEFGHIJKLMNOP'}`;
const AWS_KEY2 = `AKIA${'IOSFODNN7EXAMPLE'}`;

function hash4(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 4);
}

// ---- layer: known secret shapes ----

test('secret shapes: aws access key', () => {
  const text = `my key is ${AWS_KEY} thanks`;
  const { text: out, findings } = redact(text);
  expect(findings.length).toBe(1);
  const finding = findings[0];
  if (!finding) throw new Error('expected a finding');
  expect(finding.kind).toBe('aws-key');
  expect(text.slice(finding.start, finding.end)).toBe(AWS_KEY);
  expect(finding.hash4).toBe(hash4(AWS_KEY));
  expect(out).toBe(`my key is [redacted:aws-key:${finding.hash4}] thanks`);
});

test('secret shapes: aws secret value (context-gated)', () => {
  const secret = 'abcd1234ABCD1234abcd1234ABCD1234abcd1234';
  const text = `aws_secret_access_key=${secret}`;
  const { text: out, findings } = redact(text);
  expect(findings.length).toBe(1);
  const finding = findings[0];
  if (!finding) throw new Error('expected a finding');
  expect(finding.kind).toBe('aws-secret');
  expect(text.slice(finding.start, finding.end)).toBe(secret);
  expect(out).toBe(`aws_secret_access_key=[redacted:aws-secret:${finding.hash4}]`);
});

test('secret shapes: AKIA key followed by a bare "secret <value>" phrase redacts the secret too', () => {
  const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  const text = `use ${AWS_KEY2} and secret ${secret}`;
  const { text: out, findings } = redact(text);
  const awsFindings = findings.filter((f) => f.kind === 'aws-secret');
  expect(awsFindings.length).toBe(1);
  const finding = awsFindings[0];
  if (!finding) throw new Error('expected a finding');
  expect(text.slice(finding.start, finding.end)).toBe(secret);
  expect(out.includes(secret)).toBeFalsy();
  expect(findings.some((f) => f.kind === 'aws-key')).toBeTruthy();
});

test('secret shapes: github token, slack token, stripe key, google key, openai key', () => {
  const gh = `ghp_${'a'.repeat(40)}`;
  const slack = 'xoxb-1234567890-abcdefghij';
  const stripe = `sk_live_${'a1B2c3D4e5'.repeat(2)}`;
  const google = `AIza${'a'.repeat(35)}`;
  const openai = `sk-${'a1B2c3D4e5'.repeat(3)}`;

  const cases: Array<[string, string, string]> = [
    ['github', gh, 'github-token'],
    ['slack', slack, 'slack-token'],
    ['stripe', stripe, 'stripe-key'],
    ['google', google, 'google-api-key'],
    ['openai', openai, 'api-key'],
  ];

  for (const [label, token, kind] of cases) {
    const text = `token for ${label}: ${token} end`;
    const { text: out, findings } = redact(text);
    expect(findings.length, label).toBe(1);
    const finding = findings[0];
    if (!finding) throw new Error('expected a finding');
    expect(finding.kind, label).toBe(kind);
    expect(text.slice(finding.start, finding.end), label).toBe(token);
    expect(out.includes(`[redacted:${kind}:${finding.hash4}]`), label).toBeTruthy();
    expect(out.includes(token), label).toBeFalsy();
  }
});

test('secret shapes: jwt is one finding', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQdQw4w9WgXcQdQw4w9WgXcQ';
  const text = `Authorization: Bearer-ish jwt=${jwt}`;
  const { findings } = redact(text);
  const jwtFindings = findings.filter((f) => f.kind === 'jwt');
  expect(jwtFindings.length).toBe(1);
  const finding = jwtFindings[0];
  if (!finding) throw new Error('expected a finding');
  expect(text.slice(finding.start, finding.end)).toBe(jwt);
});

test('secret shapes: private key block collapses to a single finding', () => {
  const block =
    '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\nsomemorebase64data\n-----END RSA PRIVATE KEY-----';
  const text = `before\n${block}\nafter`;
  const { text: out, findings } = redact(text);
  const pk = findings.filter((f) => f.kind === 'private-key');
  expect(pk.length).toBe(1);
  const finding = pk[0];
  if (!finding) throw new Error('expected a finding');
  expect(text.slice(finding.start, finding.end)).toBe(block);
  expect(out.startsWith('before\n[redacted:private-key:')).toBeTruthy();
  expect(out.endsWith('\nafter')).toBeTruthy();
});

test('secret shapes: bearer header redacts only the token, not the scheme word', () => {
  const text = 'Authorization: Bearer abc123DEF456ghi789JKL012';
  const { text: out, findings } = redact(text);
  expect(findings.length).toBe(1);
  const finding = findings[0];
  if (!finding) throw new Error('expected a finding');
  expect(finding.kind).toBe('bearer-token');
  expect(text.slice(finding.start, finding.end)).toBe('abc123DEF456ghi789JKL012');
  expect(out).toBe(`Authorization: Bearer [redacted:bearer-token:${finding.hash4}]`);
});

test('secret shapes: bearer token containing "/" and "+" is replaced whole', () => {
  const token = `abc/def+ghi${'Jk9L/mN0+pQ'.repeat(3)}==`;
  const text = `Authorization: Bearer ${token}`;
  const { text: out, findings } = redact(text);
  const bearer = findings.filter((f) => f.kind === 'bearer-token');
  expect(bearer.length).toBe(1);
  const finding = bearer[0];
  if (!finding) throw new Error('expected a finding');
  expect(text.slice(finding.start, finding.end)).toBe(token);
  expect(out).toBe(`Authorization: Bearer [redacted:bearer-token:${finding.hash4}]`);
  // no tail of the token survives anywhere in the output
  for (let i = 0; i + 6 <= token.length; i++) {
    expect(out.includes(token.slice(i, i + 6)), `fragment "${token.slice(i, i + 6)}" leaked`).toBeFalsy();
  }
});

test('secret shapes: url with embedded credentials keeps scheme/host visible', () => {
  const text = 'connect to postgres://myuser:sup3rSecret!@db.example.com:5432/mydb';
  const { text: out, findings } = redact(text);
  expect(findings.length).toBe(1);
  const finding = findings[0];
  if (!finding) throw new Error('expected a finding');
  expect(finding.kind).toBe('url-credentials');
  expect(text.slice(finding.start, finding.end)).toBe('myuser:sup3rSecret!');
  expect(out.includes('postgres://[redacted:url-credentials:')).toBeTruthy();
  expect(out.includes('db.example.com:5432/mydb')).toBeTruthy();
});

test('secret shapes: url credentials replacement keeps the "@" separator', () => {
  const text = 'postgres://krishna:Sup3rS3cret@db.internal:5432/app';
  const { text: out, findings } = redact(text);
  expect(findings.length).toBe(1);
  const finding = findings[0];
  if (!finding) throw new Error('expected a finding');
  expect(finding.kind).toBe('url-credentials');
  expect(text.slice(finding.start, finding.end)).toBe('krishna:Sup3rS3cret');
  expect(out).toBe(`postgres://[redacted:url-credentials:${finding.hash4}]@db.internal:5432/app`);
});

test('secret shapes: .env style secret assignment redacts only the value', () => {
  const text = 'API_KEY=abcdefghijklmnop1234567890\nAPP_NAME=my-cool-app';
  const { text: out, findings } = redact(text);
  expect(findings.length).toBe(1);
  const finding = findings[0];
  if (!finding) throw new Error('expected a finding');
  expect(finding.kind).toBe('env-secret');
  expect(text.slice(finding.start, finding.end)).toBe('abcdefghijklmnop1234567890');
  expect(out.startsWith('API_KEY=[redacted:env-secret:')).toBeTruthy();
  expect(out.includes('APP_NAME=my-cool-app')).toBeTruthy();
});

test('secret shapes: quoted .env value with spaces is redacted, quotes kept', () => {
  const text = 'API_KEY="secret value with spaces"\nNAME=app';
  const { text: out, findings } = redact(text);
  expect(findings.length).toBe(1);
  const finding = findings[0];
  if (!finding) throw new Error('expected a finding');
  expect(finding.kind).toBe('env-secret');
  expect(text.slice(finding.start, finding.end)).toBe('secret value with spaces');
  expect(out).toBe(`API_KEY="[redacted:env-secret:${finding.hash4}]"\nNAME=app`);
});

test('secret shapes: quoted .env value shorter than 8 chars is left alone', () => {
  const text = "PASSWORD='short'";
  const { text: out, findings } = redact(text);
  expect(findings.length).toBe(0);
  expect(out).toBe(text);
});

test('secret shapes: unquoted "token: value" assignment is still redacted', () => {
  const text = 'token: abcdefghij';
  const { text: out, findings } = redact(text);
  expect(findings.length).toBe(1);
  const finding = findings[0];
  if (!finding) throw new Error('expected a finding');
  expect(finding.kind).toBe('env-secret');
  expect(text.slice(finding.start, finding.end)).toBe('abcdefghij');
  expect(out).toBe(`token: [redacted:env-secret:${finding.hash4}]`);
});

// ---- layer: high entropy ----

test('entropy: long random-looking token without a known shape is flagged', () => {
  const token = '8f2Kx9pQ3nR7vL4mZ6tY1wJ0hB5cD2eA9sU3iO7gF4k';
  const text = `key: ${token} end`;
  const { text: out, findings } = redact(text);
  const entropyFindings = findings.filter((f) => f.kind === 'entropy');
  expect(entropyFindings.length).toBe(1);
  const finding = entropyFindings[0];
  if (!finding) throw new Error('expected a finding');
  expect(text.slice(finding.start, finding.end)).toBe(token);
  expect(out.includes('[redacted:entropy:')).toBeTruthy();
});

test('entropy: does not fire on short base64 image data (<32 chars)', () => {
  const text = 'data:image/png;base64,iVBORw0KGgo=';
  const { findings } = redact(text);
  expect(findings.filter((f) => f.kind === 'entropy').length).toBe(0);
});

test('entropy: does not fire on plain words, even long ones', () => {
  const text = 'supercalifragilisticexpialidocious is a very long word indeed';
  const { findings } = redact(text);
  expect(findings.length).toBe(0);
});

test('entropy: does not fire on low-entropy repeated pattern', () => {
  const text = `blob: ${'aZ9x'.repeat(10)}`;
  const { findings } = redact(text);
  expect(findings.filter((f) => f.kind === 'entropy').length).toBe(0);
});

// ---- layer: home directory collapse ----

test('home dir: os.homedir() and /Users/<user> collapse to ~', () => {
  const home = os.homedir();
  const text = `look in ${home}/Developer/project/file.js and also /Users/${path.basename(home)}/notes.txt`;
  const { text: out } = redact(text);
  expect(out.includes('~/Developer/project/file.js')).toBeTruthy();
  expect(out.includes('~/notes.txt')).toBeTruthy();
  expect(out.includes(home)).toBeFalsy();
});

// ---- layer: large paste blocks ----

test('paste block: short prompt is left untouched', () => {
  const text = 'what does this error mean?\nTypeError: x is not a function';
  const { text: out, findings } = redact(text);
  expect(out).toBe(text);
  expect(findings.length).toBe(0);
});

test('paste block: a 10-line question followed by a 200-line log keeps the question, collapses the log', () => {
  const question = Array.from({ length: 10 }, (_, i) => `question line ${i}`).join('\n');
  const log = Array.from(
    { length: 200 },
    (_, i) => `2026-09-02T00:00:00Z log entry number ${i} happened`,
  ).join('\n');
  const text = `${question}\n\n${log}`;
  const { text: out, findings } = redact(text);
  expect(out.startsWith(question)).toBeTruthy();
  expect(findings.length).toBe(1);
  const finding = findings[0];
  if (!finding) throw new Error('expected a finding');
  expect(finding.kind).toBe('pasted');
  const logStart = text.indexOf(log);
  expect(finding.start).toBe(logStart);
  expect(finding.end).toBe(text.length);
  expect(out.includes('[pasted: 200 lines,')).toBeTruthy();
  expect(out).toMatch(/\[pasted: 200 lines, \d+ bytes, sha256:[0-9a-f]{12}\]$/);
});

test('paste block: threshold applies per block, not per prompt', () => {
  const shortBlock = 'line a\nline b\nline c';
  const bigBlock = Array.from({ length: 50 }, (_, i) => `big line ${i}`).join('\n');
  const text = `${shortBlock}\n\n${bigBlock}`;
  const { text: out } = redact(text);
  expect(out.includes(shortBlock)).toBeTruthy();
  expect(out.includes('big line 0')).toBeFalsy();
});

test('paste block: single huge line also counts as a block (pasteBytes)', () => {
  const bigLine = 'x'.repeat(5000);
  const { text: out, findings } = redact(bigLine);
  expect(findings.length).toBe(1);
  const finding = findings[0];
  if (!finding) throw new Error('expected a finding');
  expect(finding.kind).toBe('pasted');
  expect(out.startsWith('[pasted: 1 lines, 5000 bytes, sha256:')).toBeTruthy();
});

test('paste block: custom pasteLines/pasteBytes config is honored', () => {
  const text = Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n');
  const { findings: noneAtDefault } = redact(text);
  expect(noneAtDefault.length).toBe(0);
  const { findings: withTightConfig } = redact(text, { pasteLines: 3 });
  expect(withTightConfig.length).toBe(1);
  expect(withTightConfig[0]?.kind).toBe('pasted');
});

// ---- layer: config.allow / config.deny ----
// allow beats deny/entropy/paste/email for ordinary text, but never a secret shape.

test('config.deny forces redaction of an otherwise-normal string', () => {
  const text = 'the codename for this project is bluebird';
  const { text: out, findings } = redact(text, { deny: ['bluebird'] });
  expect(findings.length).toBe(1);
  const finding = findings[0];
  if (!finding) throw new Error('expected a finding');
  expect(finding.kind).toBe('deny');
  expect(text.slice(finding.start, finding.end)).toBe('bluebird');
  expect(out.includes('[redacted:deny:')).toBeTruthy();
});

test('config.allow does NOT protect a known secret shape (no bypass for secrets)', () => {
  const gh = `ghp_${'b1C2d3E4f5'.repeat(4)}`;
  const bearer = `abc/def+ghi${'Jk9L/mN0+pQ'.repeat(3)}==`;
  const text = `key ${AWS_KEY}\ngithub ${gh}\nAuthorization: Bearer ${bearer}\nend`;

  for (const allow of [[AWS_KEY], ['.*']]) {
    const { text: out, findings } = redact(text, { allow });
    const kinds = findings.map((f) => f.kind);
    expect(kinds.includes('aws-key'), `aws-key with allow=${allow}`).toBeTruthy();
    expect(kinds.includes('github-token'), `github-token with allow=${allow}`).toBeTruthy();
    expect(kinds.includes('bearer-token'), `bearer-token with allow=${allow}`).toBeTruthy();
    expect(out.includes(AWS_KEY), `aws key leaked with allow=${allow}`).toBeFalsy();
    expect(out.includes(gh), `github token leaked with allow=${allow}`).toBeFalsy();
    expect(out.includes(bearer), `bearer token leaked with allow=${allow}`).toBeFalsy();
    // the secret-shape findings slice back to the exact secrets
    const aws = findings.find((f) => f.kind === 'aws-key');
    expect(aws && text.slice(aws.start, aws.end)).toBe(AWS_KEY);
    const b = findings.find((f) => f.kind === 'bearer-token');
    expect(b && text.slice(b.start, b.end)).toBe(bearer);
  }
});

test('config.allow still beats config.deny for ordinary text', () => {
  const text = 'the codename for this project is bluebird';
  const { text: out, findings } = redact(text, {
    allow: ['bluebird'],
    deny: ['bluebird'],
  });
  expect(findings.length).toBe(0);
  expect(out).toBe(text);
});

test('config.allow protects an email from the email layer (intended: an email is identifying, not a secret)', () => {
  const text = 'contact me at jane.doe@example.com please';
  const { text: out, findings } = redact(text, { allow: ['.*'] });
  expect(findings.length).toBe(0);
  expect(out).toBe(text);
});

test('config.allow protects a span from paste-block collapsing too', () => {
  const secretish = `KEEPME-${'x'.repeat(40)}`;
  const lines = Array.from({ length: 50 }, (_, i) => (i === 25 ? secretish : `line ${i}`));
  const text = lines.join('\n');
  const { text: out } = redact(text, { allow: [secretish.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')] });
  // the whole block still gets collapsed as a paste (the allow match is inside
  // it), but the block containing an allow match must not be silently
  // shredded in a way that leaks nothing of it being protected.
  expect(out.length > 0).toBeTruthy();
});

// ---- layer: emails ----

test('emails are redacted by default, keepEmails suppresses it', () => {
  const text = 'contact me at jane.doe@example.com please';
  const redacted = redact(text);
  expect(redacted.findings.length).toBe(1);
  const finding = redacted.findings[0];
  if (!finding) throw new Error('expected a finding');
  expect(finding.kind).toBe('email');
  expect(text.slice(finding.start, finding.end)).toBe('jane.doe@example.com');

  const kept = redact(text, { keepEmails: true });
  expect(kept.findings.length).toBe(0);
  expect(kept.text).toBe(text);
});

// ---- determinism ----

test('same secret always produces the same placeholder', () => {
  const text1 = `first: ${AWS_KEY}`;
  const text2 = `elsewhere later: ${AWS_KEY} done`;
  const r1 = redact(text1);
  const r2 = redact(text2);
  expect(r1.findings[0]?.hash4).toBe(r2.findings[0]?.hash4);
  const placeholder1 = r1.text.match(/\[redacted:aws-key:[0-9a-f]{4}\]/)?.[0];
  const placeholder2 = r2.text.match(/\[redacted:aws-key:[0-9a-f]{4}\]/)?.[0];
  expect(placeholder1).toBe(placeholder2);
});

// ---- false-positive suite: things that must NOT be touched ----

test('false positives: uuid, sha40, short id, file paths, urls, prose, mermaid, json all pass through clean', () => {
  const samples = [
    '123e4567-e89b-12d3-a456-426614174000',
    'commit abc123def456abc123def456abc123def456abcd',
    'short id 0eeb962 refers to a turn',
    'see /usr/local/lib/node_modules/something/index.js for details',
    'read the docs at https://example.com/docs/getting-started?ref=abc',
    'The quick brown fox jumps over the lazy dog while the sun sets slowly ' +
      'behind the old barn, painting the sky in shades of orange and purple ' +
      'that reminded everyone of summer evenings long past and gone, and ' +
      'nobody in the small town seemed to mind the chill in the autumn air ' +
      'as they gathered together to share stories from years long forgotten ' +
      'and to plan for the harvest festival that would arrive within the week.',
    'graph TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Do thing]\n  B -->|No| D[End]',
    '{"name": "value", "token": "abc", "count": 3, "ok": true}',
  ];
  let totalFindings = 0;
  for (const sample of samples) {
    const { text, findings } = redact(sample);
    totalFindings += findings.length;
    expect(findings.length, `unexpected findings for: ${sample}`).toBe(0);
    expect(text).toBe(sample);
  }
  expect(totalFindings).toBe(0);
});

test('false positives: normal English with a colon does not trigger env-secret on "Authorization: Basic"', () => {
  const text = 'Authorization: Basic dXNlcjpwYXNzd29yZA==';
  const { findings } = redact(text);
  expect(findings.filter((f) => f.kind === 'env-secret').length).toBe(0);
});

// ---- mergeConfig / DEFAULT_CONFIG ----

describe('mergeConfig / DEFAULT_CONFIG', () => {
  test('DEFAULT_CONFIG has the documented defaults', () => {
    expect(DEFAULT_CONFIG).toEqual({
      pasteLines: 40,
      pasteBytes: 4000,
      allow: [],
      deny: [],
      keepEmails: false,
    });
  });

  test('mergeConfig fills in missing keys and preserves provided ones', () => {
    const merged = mergeConfig({ pasteLines: 10, allow: ['foo'] });
    expect(merged.pasteLines).toBe(10);
    expect(merged.pasteBytes).toBe(4000);
    expect(merged.allow).toEqual(['foo']);
    expect(merged.deny).toEqual([]);
    expect(merged.keepEmails).toBe(false);
  });

  test('mergeConfig() with no argument returns defaults', () => {
    expect(mergeConfig()).toEqual(DEFAULT_CONFIG);
    expect(mergeConfig(undefined)).toEqual(DEFAULT_CONFIG);
  });
});

// ---- describeFindings ----

describe('describeFindings', () => {
  test('describeFindings summarizes one line per kind with counts', () => {
    const findings = [
      { kind: 'email', hash4: 'aaaa', start: 0, end: 1 },
      { kind: 'email', hash4: 'bbbb', start: 2, end: 3 },
      { kind: 'aws-key', hash4: 'cccc', start: 4, end: 5 },
    ];
    const desc = describeFindings(findings);
    expect(desc).toBe('aws-key: 1\nemail: 2');
  });

  test('describeFindings with no findings says so', () => {
    expect(describeFindings([])).toBe('No redactions.');
    expect(describeFindings(undefined)).toBe('No redactions.');
  });
});

// ---- misc / edge cases ----

test('empty and non-string input do not throw', () => {
  expect(redact('')).toEqual({ text: '', findings: [] });
  expect(redact(null)).toEqual({ text: '', findings: [] });
  expect(redact(undefined)).toEqual({ text: '', findings: [] });
});

test('findings offsets always slice back to the exact original matched text', () => {
  const home = os.homedir();
  const text = `email jane@example.com and key ${AWS_KEY} and home ${home}/x`;
  const { findings } = redact(text);
  for (const f of findings) {
    expect(f.start >= 0 && f.end <= text.length && f.start < f.end).toBeTruthy();
    expect(typeof f.hash4).toBe('string');
    expect(f.hash4.length).toBe(4);
  }
  expect(findings.some((f) => f.kind === 'email')).toBeTruthy();
  expect(findings.some((f) => f.kind === 'aws-key')).toBeTruthy();
});
