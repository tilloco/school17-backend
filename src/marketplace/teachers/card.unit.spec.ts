import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { formatCard, luhnValid, normalizeCardNumber, normalizeHolderName } from './card';
import { CryptoUnavailableError, cryptoAvailable, decryptField, encryptField } from '../common/data-crypto';

const GOOD = '4111111111111111'; // mashhur test raqami (Luhn to'g'ri)
const KEY = 'a'.repeat(64);

describe('card validation (pure)', () => {
  it('Luhn', () => {
    assert.equal(luhnValid(GOOD), true);
    assert.equal(luhnValid('4111111111111112'), false);
    assert.equal(luhnValid('1234567890123456'), false);
    assert.equal(luhnValid('abc'), false);
  });
  it('accepts exactly 16 digits (spaces/dashes allowed), nothing else', () => {
    assert.equal(normalizeCardNumber('4111 1111 1111 1111'), GOOD);
    assert.equal(normalizeCardNumber('4111-1111-1111-1111'), GOOD);
    for (const bad of ['411111111111111', '41111111111111111', '4111 1111 1111 1112', '4111 1111 1111 1111 12/27', '4111********1111', '4111111111111111 123', '', ' ', '4111/1111/1111/1111', '4111.1111.1111.1111', 'card 4111111111111111']) {
      assert.equal(normalizeCardNumber(bad), null, bad);
    }
    assert.equal(normalizeCardNumber(4111111111111111 as unknown as string), null);
  });
  it('holder name: 2-40 letters, spaces, hyphen, apostrophe', () => {
    assert.equal(normalizeHolderName('  ALI  VALIYEV '), 'ALI VALIYEV');
    assert.equal(normalizeHolderName('Ali\u000aVali'), 'Ali Vali', 'line breaks collapse to a space');
    assert.equal(normalizeHolderName("Gulnora O'ral"), "Gulnora O'ral");
    assert.equal(normalizeHolderName('Анна-Мария Иванова'), 'Анна-Мария Иванова');
    for (const bad of ['A', 'x'.repeat(41), 'Ali123', 'Ali 12/27', '<script>', 'Ali--Vali', '', "'Ali", 'Ali@mail.com', '123 456']) assert.equal(normalizeHolderName(bad), null, bad);
  });
  it('formatting', () => assert.equal(formatCard(GOOD), '4111 1111 1111 1111'));
});

describe('field encryption (AES-256-GCM)', () => {
  const env = { APP_DATA_KEY: KEY, NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv;
  it('round-trips, never contains the plaintext, uses a fresh IV each time', () => {
    const a = encryptField(GOOD, env);
    const b = encryptField(GOOD, env);
    assert.notEqual(a, b);
    assert.ok(!a.includes(GOOD));
    assert.equal(decryptField(a, env), GOOD);
  });
  it('tampering and wrong keys are detected', () => {
    const a = encryptField(GOOD, env);
    const parts = a.split('.');
    parts[3] = Buffer.from('x' + Buffer.from(parts[3], 'base64url').toString('latin1').slice(1), 'latin1').toString('base64url');
    assert.throws(() => decryptField(parts.join('.'), env));
    assert.throws(() => decryptField(a, { APP_DATA_KEY: 'b'.repeat(64), NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv));
    assert.throws(() => decryptField('v2.a.b.c', env));
  });
  it('production without a key is unavailable (never silently falls back); dev has a warned fallback; bad keys are rejected', () => {
    assert.equal(cryptoAvailable({ NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv), false);
    assert.throws(() => encryptField('x', { NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv), CryptoUnavailableError);
    assert.equal(cryptoAvailable({ NODE_ENV: 'development' } as unknown as NodeJS.ProcessEnv), true);
    assert.throws(() => encryptField('x', { APP_DATA_KEY: 'short', NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv), /32 bytes/);
    const b64 = Buffer.alloc(32, 7).toString('base64');
    assert.equal(decryptField(encryptField('hi', { APP_DATA_KEY: b64 } as unknown as NodeJS.ProcessEnv), { APP_DATA_KEY: b64 } as unknown as NodeJS.ProcessEnv), 'hi');
  });
});
