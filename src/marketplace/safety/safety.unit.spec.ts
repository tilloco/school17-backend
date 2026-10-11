import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { detectContactInfo } from './contact-info';
import { SAFETY_TIPS } from './tips';
import { LEGAL_TEXTS } from '../legal/texts';

describe('contact-info detector', () => {
  const positives: [string, string][] = [
    ['+998 90 123 45 67', 'phone'], ['call 90 123 45 67 now', 'phone'], ['901234567', 'phone'], ['998901234567', 'phone'], ['8 (926) 123-45-67', 'phone'],
    ['me@mail.com', 'email'], ['name at gmail dot com', 'email'], ['t.me/ali_teacher', 'url'], ['https://example.com/x', 'url'], ['www.site.uz', 'url'],
    ['@teacher_ali', 'handle'], ['add me on Telegram', 'messenger'], ['напиши мне в ватсап', 'messenger'], ['instagramda yoz', 'messenger'], ['мой тг', 'messenger'],
  ];
  const negatives = [
    '12 + 34 = 46', 'Chapter 3, page 45', '2026-11-03 14:30', 'Solve x^2 = 144', '3.14159', 'The answer is 123456', 'Dars 10:30 da', '5 000 000 so\'m', 'Grade 11, task 7(b)',
    'Salom! Bugun 17.00 da uchrashamiz', 'Задача №25, страница 112', 'f(x) = 2x + 1', '15 november 2026', '1 2 3 4 5 6 7', 'Please send the homework photo',
  ];
  for (const [text, kind] of positives) {
    it(`flags "${text}"`, () => {
      const r = detectContactInfo(text);
      assert.equal(r.found, true, text);
      assert.ok(r.kinds.includes(kind as any), `${text} -> ${r.kinds}`);
    });
  }
  for (const text of negatives) {
    it(`allows "${text}"`, () => assert.equal(detectContactInfo(text).found, false, text));
  }
});

describe('safety tips and legal drafts', () => {
  it('every audience has the same number of tips in uz/ru/en', () => {
    for (const a of ['pupil', 'guardian', 'teacher'] as const) {
      const n = SAFETY_TIPS[a].en.length;
      assert.ok(n >= 4);
      assert.equal(SAFETY_TIPS[a].uz.length, n, a);
      assert.equal(SAFETY_TIPS[a].ru.length, n, a);
    }
  });
  it('legal drafts: all locales have the same sections, carry a visible draft banner, and make no unproven security claims', () => {
    for (const kind of ['terms', 'privacy'] as const) {
      const n = LEGAL_TEXTS[kind].en.sections.length;
      for (const loc of ['uz', 'ru', 'en'] as const) {
        const d = LEGAL_TEXTS[kind][loc];
        assert.equal(d.sections.length, n, `${kind}/${loc}`);
        assert.match(d.draftBanner, /QORALAMA|ЧЕРНОВИК|DRAFT/);
        assert.match(d.title, /qoralama|черновик|draft/i);
        const all = d.sections.map((s) => s.body).join('\n');
        assert.ok(!/military|bank-grade|100% secure|fully secure|unhackable/i.test(all));
        assert.ok(!/(?<!not )(?<!NOT )(?<!НЕ )(?<!не )end-to-end encrypted/.test(all) || /not end-to-end|NOT end-to-end/.test(all));
      }
    }
    assert.match(LEGAL_TEXTS.privacy.en.sections.map((s) => s.body).join(' '), /NOT end-to-end encrypted/);
  });
});
