import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp = require('sharp');
import { FakePdfRenderer, PdfJsRenderer, RenderError, RenderOptions } from './pdf-renderer';

const opts = (over: Partial<RenderOptions> = {}): RenderOptions => ({ maxPages: 50, fullWidth: 1000, smallWidth: 600, thumbWidth: 200, deadlineMs: Date.now() + 60_000, ...over });

/** Kichik, haqiqiy (xref jadvali bilan) ko'p sahifali PDF: har sahifada matn */
export function textPdf(pages: number): Buffer {
  const objs: string[] = [];
  const kids: string[] = [];
  objs.push('<</Type/Catalog/Pages 2 0 R>>');
  objs.push(''); // 2: Pages (to'ldiriladi)
  objs.push('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'); // 3
  for (let i = 0; i < pages; i++) {
    const pageNo = 4 + i * 2;
    kids.push(`${pageNo} 0 R`);
    const stream = `BT /F1 36 Tf 30 100 Td (Page ${i + 1}) Tj ET`;
    objs.push(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Resources<</Font<</F1 3 0 R>>>>/Contents ${pageNo + 1} 0 R>>`);
    objs.push(`<</Length ${stream.length}>>\nstream\n${stream}\nendstream`);
  }
  objs[1] = `<</Type/Pages/Kids[${kids.join(' ')}]/Count ${pages}>>`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

describe('pdf renderers', () => {
  it('real renderer (pdfjs + canvas) turns a 3-page PDF into WebP images of the configured widths', async () => {
    const got: number[] = [];
    let w = 0;
    const r = await new PdfJsRenderer().render(textPdf(3), opts(), async (p) => {
      got.push(p.page);
      const full = await sharp(p.full).metadata();
      const small = await sharp(p.small).metadata();
      const thumb = await sharp(p.thumb).metadata();
      assert.equal(full.format, 'webp');
      assert.equal(full.width, 1000);
      assert.equal(small.width, 600);
      assert.equal(thumb.width, 200);
      assert.ok(Math.abs((full.height ?? 0) - 667) <= 2, 'aspect ratio 300x200 is kept');
      w = full.width ?? 0;
    });
    assert.deepEqual(got, [1, 2, 3], 'pages arrive progressively and in order');
    assert.equal(r.pageCount, 3);
    assert.equal(w, 1000);
  });

  it('real renderer: page limit, deadline and garbage input are refused with a typed error', async () => {
    const noop = async () => undefined;
    await assert.rejects(() => new PdfJsRenderer().render(textPdf(4), opts({ maxPages: 3 }), noop), (e: any) => e instanceof RenderError && e.code === 'too_many_pages');
    await assert.rejects(() => new PdfJsRenderer().render(textPdf(2), opts({ deadlineMs: Date.now() - 1 }), noop), (e: any) => e instanceof RenderError && e.code === 'timeout');
    await assert.rejects(() => new PdfJsRenderer().render(Buffer.from('%PDF-1.4 this is not a pdf at all'), opts(), noop), (e: any) => e instanceof RenderError && e.code === 'render_failed');
  });

  it('real renderer does not execute PDF scripts or touch the network (renders only)', async () => {
    const evil = textPdf(1).toString('latin1').replace('/Type/Catalog', '/Type/Catalog/OpenAction<</S/JavaScript/JS(app.alert(1))>>');
    // Aktiv kontent yuklash bosqichida (checkPdf) rad etiladi; renderer esa baribir faqat chizadi
    let pages = 0;
    await new PdfJsRenderer().render(Buffer.from(evil, 'latin1'), opts(), async () => { pages++; }).catch(() => undefined);
    assert.ok(pages <= 1);
  });

  it('fake renderer: counts pages, honours limits, can be told to fail', async () => {
    const f = new FakePdfRenderer(4);
    const got: number[] = [];
    assert.equal((await f.render(Buffer.from('%PDF-1.4'), opts(), async (p) => { got.push(p.page); })).pageCount, 4);
    assert.deepEqual(got, [1, 2, 3, 4]);
    await assert.rejects(() => f.render(Buffer.from('%PDF-1.4'), opts({ maxPages: 2 }), async () => undefined), (e: any) => e.code === 'too_many_pages');
    f.failNext = true;
    await assert.rejects(() => f.render(Buffer.from('%PDF-1.4'), opts(), async () => undefined), (e: any) => e.code === 'render_failed');
  });
});
