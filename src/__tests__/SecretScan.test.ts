const { scan, scanText } = require('../../scripts/secret-scan');

describe('secret scan gate', () => {
  test('no new secret-like values outside the tracked known issues', () => {
    const { unexpected } = scan();
    expect(unexpected).toEqual([]);
  });

  test('the repository has no secret-like values at all (strict)', () => {
    const { findings } = scan();
    expect(findings).toEqual([]);
  });

  test('detects JWTs, private keys and literal signing passwords', () => {
    const jwt = ['eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9', 'eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFu', 'abcdefghijklmnopqrstuvwx'].join('.');
    expect(scanText('a.ts', `const t = '${jwt}';`)).toEqual([{ file: 'a.ts', line: 1, rule: 'jwt' }]);
    expect(scanText('k.ts', '-----BEGIN PRIVATE KEY-----')).toHaveLength(1);
    expect(scanText('b.gradle', "storePassword 'hunter2hunter2'")).toEqual([
      { file: 'b.gradle', line: 1, rule: 'gradle-signing-password' },
    ]);
  });

  test('ignores the public debug keystore password and env-driven values', () => {
    expect(scanText('b.gradle', "storePassword 'android'")).toEqual([]);
    expect(scanText('b.gradle', 'storePassword System.getenv("KS_PASS")')).toEqual([]);
    expect(scanText('a.ts', 'const x = "not a token";')).toEqual([]);
  });
});
