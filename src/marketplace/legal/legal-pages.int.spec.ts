import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { createTestApp, TestApp } from '../testing/harness';

describe('public legal pages (integration)', () => {
  let t: TestApp;
  before(async () => { t = await createTestApp(); });
  after(async () => { await t.close(); delete process.env.SUPPORT_EMAIL; delete process.env.LEGAL_REVIEWED; delete process.env.LEGAL_RETENTION; });

  it('privacy, terms and delete-account are public web pages in three languages', async () => {
    for (const path of ['privacy', 'terms', 'delete-account']) {
      for (const lang of ['uz', 'ru', 'en']) {
        const r = await fetch(`${t.baseUrl}/${path}?lang=${lang}`);
        assert.equal(r.status, 200, `${path} ${lang}`);
        assert.ok(r.headers.get('content-type')!.startsWith('text/html'));
        const html = await r.text();
        assert.ok(html.includes(`<html lang="${lang}">`), `${path} ${lang}`);
        assert.ok(html.length > 1500, `${path} ${lang} has real content`);
      }
    }
    const byHeader = await (await fetch(`${t.baseUrl}/privacy`, { headers: { 'accept-language': 'ru-RU,ru;q=0.9' } })).text();
    assert.ok(byHeader.includes('<html lang="ru">'));
  });

  it('the draft banner stays until the policy is marked reviewed, and open brackets are filled from the settings', async () => {
    delete process.env.SUPPORT_EMAIL; delete process.env.LEGAL_REVIEWED; delete process.env.LEGAL_RETENTION;
    const draft = await (await fetch(`${t.baseUrl}/privacy?lang=en`)).text();
    assert.ok(draft.includes('class="banner"'), 'draft banner is shown by default');
    assert.ok(draft.includes('[contact]'), 'an unset contact stays visibly open');
    process.env.SUPPORT_EMAIL = 'help@school17.example'; process.env.LEGAL_REVIEWED = '1'; process.env.LEGAL_RETENTION = '12 months';
    const done = await (await fetch(`${t.baseUrl}/privacy?lang=en`)).text();
    assert.equal(done.includes('class="banner"'), false);
    assert.ok(done.includes('help@school17.example'));
    assert.equal(done.includes('[contact]'), false);
    assert.equal(done.includes('[period to be set by a lawyer]'), false);
    const del = await (await fetch(`${t.baseUrl}/delete-account?lang=en`)).text();
    assert.ok(del.includes('help@school17.example') && del.includes('Delete account'));
  });

  it('everything is escaped and the page forbids scripts', async () => {
    const r = await fetch(`${t.baseUrl}/privacy?lang=<script>alert(1)</script>`);
    const html = await r.text();
    assert.equal(html.includes('<script>'), false);
    assert.ok((r.headers.get('content-security-policy') ?? '').includes("default-src 'none'"));
  });
});
