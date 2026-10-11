import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPdf, detectType } from './sniff';
import { sign, signedQuery, verifySignature } from './signing';
import { LocalDiskStorage } from './storage';
import { makeJpeg, makePdf } from '../testing/harness';

describe('content sniffing (never trusts the declared type)', () => {
  it('recognises the four allowed formats by magic bytes', async () => {
    assert.equal(detectType(await makeJpeg(8, 8, false)), 'jpeg');
    assert.equal(detectType(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)])), 'png');
    assert.equal(detectType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(8)])), 'webp');
    assert.equal(detectType(makePdf()), 'pdf');
  });
  it('rejects SVG, HTML, scripts, executables, archives, GIF', () => {
    const samples: Record<string, Buffer> = {
      svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'),
      svgxml: Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'),
      html: Buffer.from('<!doctype html><script>alert(1)</script>'),
      js: Buffer.from('console.log("hi"); alert(document.cookie);'),
      exe: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]),
      elf: Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(64)]),
      zip: Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(64)]),
      gif: Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(32)]),
      script: Buffer.from('#!/bin/sh\nrm -rf /\n'),
    };
    for (const [name, b] of Object.entries(samples)) assert.equal(detectType(b), null, name);
  });
  it('a PDF header that is not at offset 0 is not accepted (polyglot guard)', () => {
    assert.equal(detectType(Buffer.concat([Buffer.from('<html>      '), makePdf()])), null);
  });
  it('PDF check: active content and truncation are rejected', () => {
    assert.equal(checkPdf(makePdf()).ok, true);
    assert.equal(checkPdf(makePdf()).pageCount, 1);
    assert.deepEqual(checkPdf(makePdf({ extra: '4 0 obj<</S/JavaScript/JS(app.alert(1))>>endobj\n' })), { ok: false, reason: 'pdf_active_content' });
    assert.deepEqual(checkPdf(makePdf({ extra: '/OpenAction 5 0 R\n' })), { ok: false, reason: 'pdf_active_content' });
    assert.deepEqual(checkPdf(makePdf({ extra: '/EmbeddedFile\n' })), { ok: false, reason: 'pdf_active_content' });
    assert.equal(checkPdf(makePdf().subarray(0, 100)).ok, false);
  });
});

describe('signed URLs', () => {
  const p = { op: 'get' as const, fileId: 'f1', part: 'original', uid: 'u1', exp: 2_000_000_000 };
  const now = 1_900_000_000_000;
  it('valid signature passes; every field is bound', () => {
    const sig = sign('s3cret', p);
    assert.equal(verifySignature('s3cret', p, sig, now), true);
    assert.equal(verifySignature('other', p, sig, now), false);
    for (const tampered of [{ ...p, fileId: 'f2' }, { ...p, part: 'thumb' }, { ...p, uid: 'u2' }, { ...p, op: 'put' as const }, { ...p, exp: p.exp + 1 }]) {
      assert.equal(verifySignature('s3cret', tampered, sig, now), false);
    }
  });
  it('expired and malformed signatures fail', () => {
    assert.equal(verifySignature('s3cret', p, sign('s3cret', p), 2_000_000_001_000), false);
    assert.equal(verifySignature('s3cret', p, '', now), false);
    assert.equal(verifySignature('s3cret', p, 'x'.repeat(10), now), false);
    assert.equal(verifySignature('s3cret', { ...p, exp: NaN }, 'x', now), false);
    assert.match(signedQuery('s3cret', p), /^uid=u1&exp=2000000000&sig=/);
  });
});

describe('LocalDiskStorage', () => {
  it('stores and lists; rejects path traversal and odd keys', async () => {
    const s = new LocalDiskStorage(mkdtempSync(join(tmpdir(), 'st-')));
    await s.put('f_a/parts/0', Buffer.from('hi'));
    assert.equal((await s.get('f_a/parts/0')).toString(), 'hi');
    assert.deepEqual(await s.list('f_a/parts'), ['f_a/parts/0']);
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'a\\b', 'a b', 'C:/x', '']) {
      await assert.rejects(s.put(bad, Buffer.from('x')), /Invalid storage key/, bad);
    }
    await s.deletePrefix('f_a');
    assert.equal(await s.exists('f_a/parts/0'), false);
  });
});
