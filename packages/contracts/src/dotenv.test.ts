import { describe, expect, it } from 'vitest';
import { parseDotenv, toDotenv } from './dotenv.js';

describe('.env files', () => {
  it('reads a file the way the common loaders do', () => {
    const { entries, problems } = parseDotenv(
      [
        '# the database',
        'DATABASE_URL=postgres://app:pw@db:5432/app',
        'export LOG_LEVEL = info   # a comment',
        "LITERAL='a $dollar and \\n stays'",
        'GREETING="line one\\nline two"',
        'PRIVATE_KEY="-----BEGIN KEY-----',
        'abc',
        '-----END KEY-----"',
        'EMPTY=',
        'LOG_LEVEL=debug',
        '',
      ].join('\r\n'),
    );
    expect(problems).toEqual([]);
    expect(Object.fromEntries(entries.map((e) => [e.key, e.value]))).toEqual({
      DATABASE_URL: 'postgres://app:pw@db:5432/app',
      // A later line wins, as it does for the app.
      LOG_LEVEL: 'debug',
      LITERAL: 'a $dollar and \\n stays',
      GREETING: 'line one\nline two',
      PRIVATE_KEY: '-----BEGIN KEY-----\nabc\n-----END KEY-----',
      EMPTY: '',
    });
  });

  it('says which lines it could not read, and keeps the rest', () => {
    const { entries, problems } = parseDotenv('GOOD=1\nnot a setting\n1BAD=2\nOPEN="never closed');
    expect(entries).toEqual([{ key: 'GOOD', value: '1' }]);
    expect(problems).toEqual([
      'Line 2 is not NAME=value',
      'Line 3: 1BAD is not a setting name',
      'Line 4: the quote around OPEN is never closed',
    ]);
  });

  it('writes a file that reads back the same, with encrypted values left out', () => {
    const env = [
      { key: 'PLAIN', value: 'info' },
      { key: 'SPACED', value: 'two words "quoted"\nand a line' },
      { key: 'TOKEN', secretRef: 'sec_01' },
    ];
    const written = toDotenv(env);
    expect(written).toContain('# TOKEN is stored encrypted in VDeploy');
    expect(parseDotenv(written).entries).toEqual([
      { key: 'PLAIN', value: 'info' },
      { key: 'SPACED', value: 'two words "quoted"\nand a line' },
      { key: 'TOKEN', value: '' },
    ]);
  });
});
