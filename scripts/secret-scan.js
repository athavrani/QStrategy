#!/usr/bin/env node
/**
 * Release-gate secret scan. Fails on credential-like strings outside the tracked known-issue list.
 *   node scripts/secret-scan.js            known issues are reported as warnings
 *   node scripts/secret-scan.js --strict   known issues fail too (use once they are fixed)
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// Keep in sync with ENHANCEMENT_REFERENCE.md section 8; add an entry only for an issue tracked there.
const KNOWN_ISSUES = {};

const RULES = [
  { id: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  // Debug keystore uses the public default 'android'
  { id: 'gradle-signing-password', re: /(?:store|key)Password\s*[= ]\s*['"](?!android['"])[^'"$]{4,}['"]/ },
];

const SCAN_TARGETS = ['src', 'App.tsx', 'android/app/build.gradle', 'android/gradle.properties'];
const SKIP_DIRS = new Set(['__tests__', 'node_modules', 'build', '.git']);
const TEXT_EXT = /\.(ts|tsx|js|jsx|json|gradle|properties|kts)$/;

function scanText(file, text) {
  const findings = [];
  text.split(/\r?\n/).forEach((line, idx) => {
    for (const rule of RULES) {
      if (rule.re.test(line)) findings.push({ file, line: idx + 1, rule: rule.id });
    }
  });
  return findings;
}

function walk(abs, rel, out) {
  if (!fs.existsSync(abs)) return;
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(abs)) {
      if (SKIP_DIRS.has(name)) continue;
      walk(path.join(abs, name), `${rel}/${name}`, out);
    }
  } else if (TEXT_EXT.test(abs)) {
    out.push(...scanText(rel, fs.readFileSync(abs, 'utf8')));
  }
}

function trackedKeystores() {
  try {
    return execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' })
      .split(/\r?\n/)
      .filter((f) => /\.(jks|keystore)$/.test(f) && !/debug\.keystore$/.test(f))
      .map((file) => ({ file, line: 0, rule: 'tracked-keystore' }));
  } catch {
    return [];
  }
}

function scan(root = ROOT) {
  const findings = [];
  for (const target of SCAN_TARGETS) walk(path.join(root, target), target, findings);
  if (root === ROOT) findings.push(...trackedKeystores());

  const known = findings.filter((f) => KNOWN_ISSUES[f.file]);
  const unexpected = findings.filter((f) => !KNOWN_ISSUES[f.file]);
  return { findings, known, unexpected };
}

function main() {
  const strict = process.argv.includes('--strict');
  const { known, unexpected } = scan();

  known.forEach((f) => console.warn(`WARN  ${f.file}:${f.line} [${f.rule}] ${KNOWN_ISSUES[f.file]}`));
  unexpected.forEach((f) => console.error(`FAIL  ${f.file}:${f.line} [${f.rule}] new secret-like value`));

  const failed = unexpected.length > 0 || (strict && known.length > 0);
  console.log(
    `secret-scan: ${unexpected.length} new, ${known.length} known${strict ? ' (strict)' : ''} -> ${failed ? 'FAILED' : 'ok'}`
  );
  process.exit(failed ? 1 : 0);
}

module.exports = { scan, scanText, KNOWN_ISSUES };

if (require.main === module) main();
