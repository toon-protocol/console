import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PassphraseRequiredError, WrongPassphraseError } from './keystore.js';
import { PassphraseFileKeystore } from './keystore-file.js';

const SECRET = '{"v":1,"kind":"local","nsec":"nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzz"}';

describe('the passphrase-encrypted keystore file', () => {
  let dir: string;
  let path: string;
  let keystore: PassphraseFileKeystore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'toon-console-keystore-'));
    path = join(dir, 'keystore.json');
    keystore = new PassphraseFileKeystore(path);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('gives back what it was given, under the right passphrase', async () => {
    await keystore.put('one', SECRET, { passphrase: 'correct horse' });
    expect(await keystore.get('one', { passphrase: 'correct horse' })).toBe(SECRET);
  });

  it('holds no plaintext on disk', async () => {
    await keystore.put('one', SECRET, { passphrase: 'correct horse' });
    const onDisk = readFileSync(path, 'utf8');
    expect(onDisk).not.toContain('nsec1');
    expect(onDisk).not.toContain('correct horse');
  });

  it('is readable by its owner and nobody else', async () => {
    await keystore.put('one', SECRET, { passphrase: 'correct horse' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('refuses the wrong passphrase rather than returning rubbish', async () => {
    await keystore.put('one', SECRET, { passphrase: 'correct horse' });
    await expect(keystore.get('one', { passphrase: 'wrong horse' })).rejects.toBeInstanceOf(
      WrongPassphraseError
    );
  });

  it('asks for a passphrase when none was given', async () => {
    await expect(keystore.put('one', SECRET, {})).rejects.toBeInstanceOf(
      PassphraseRequiredError
    );
  });

  it('detects a tampered record instead of decrypting it', async () => {
    await keystore.put('one', SECRET, { passphrase: 'correct horse' });
    const file = JSON.parse(readFileSync(path, 'utf8')) as {
      records: Record<string, { ciphertext: string }>;
    };
    const record = file.records.one;
    if (!record) throw new Error('the record was not written');
    const bytes = Buffer.from(record.ciphertext, 'base64');
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    record.ciphertext = bytes.toString('base64');
    writeFileSync(path, JSON.stringify(file));
    await expect(keystore.get('one', { passphrase: 'correct horse' })).rejects.toBeInstanceOf(
      WrongPassphraseError
    );
  });

  it('will not open a record moved under another id', async () => {
    await keystore.put('one', SECRET, { passphrase: 'correct horse' });
    const file = JSON.parse(readFileSync(path, 'utf8')) as {
      version: 1;
      records: Record<string, unknown>;
    };
    writeFileSync(path, JSON.stringify({ version: 1, records: { two: file.records.one } }));
    await expect(keystore.get('two', { passphrase: 'correct horse' })).rejects.toBeInstanceOf(
      WrongPassphraseError
    );
  });

  it('keeps records apart, each under its own passphrase', async () => {
    await keystore.put('one', 'first', { passphrase: 'alpha' });
    await keystore.put('two', 'second', { passphrase: 'beta' });
    expect(await keystore.get('one', { passphrase: 'alpha' })).toBe('first');
    expect(await keystore.get('two', { passphrase: 'beta' })).toBe('second');
  });

  it('has nothing for an id it was never given', async () => {
    expect(await keystore.get('missing', { passphrase: 'alpha' })).toBeUndefined();
  });

  it('forgets a record for good', async () => {
    await keystore.put('one', SECRET, { passphrase: 'alpha' });
    await keystore.remove('one');
    expect(await keystore.get('one', { passphrase: 'alpha' })).toBeUndefined();
    expect(readFileSync(path, 'utf8')).not.toContain('ciphertext');
  });

  it('survives a file it cannot read rather than refusing to start', async () => {
    writeFileSync(path, 'not json at all');
    expect(await keystore.get('one', { passphrase: 'alpha' })).toBeUndefined();
  });
});
