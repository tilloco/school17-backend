// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp = require('sharp');

/** PDF sahifalarini rasmga aylantirish (R5). Foydalanuvchilar xom PDF'ni xonada HECH QACHON ochmaydi: faqat shu rasmlar tarqatiladi. */
export interface RenderedPage {
  page: number; // 1 dan
  full: Buffer; // ~1000 px kenglikdagi WebP
  small: Buffer; // sust tarmoq uchun ~600 px
  thumb: Buffer; // ~200 px eskiz
  width: number;
  height: number;
}

export interface RenderOptions {
  maxPages: number;
  fullWidth: number;
  smallWidth: number;
  thumbWidth: number;
  /** Mutlaq muddat (ms, Date.now() shkalasida); undan oshsa to'xtaydi */
  deadlineMs: number;
}

export class RenderError extends Error {
  constructor(public code: 'too_many_pages' | 'timeout' | 'render_failed' | 'encrypted', message?: string) {
    super(message ?? code);
  }
}

export interface PdfRenderer {
  readonly name: string;
  /** Sahifalarni ketma-ket beradi (progressiv: tayyor bo'lgan sahifa darhol onPage orqali yoziladi). Sahifalar sonini qaytaradi. */
  render(pdf: Buffer, opts: RenderOptions, onPage: (p: RenderedPage) => Promise<void>, onCount?: (n: number) => Promise<void>): Promise<{ pageCount: number }>;
}

export const PDF_RENDERER = Symbol('PDF_RENDERER');

async function encode(png: Buffer, o: RenderOptions) {
  const meta = await sharp(png).metadata();
  const full = await sharp(png).resize({ width: o.fullWidth, withoutEnlargement: false }).webp({ quality: 78 }).toBuffer();
  const small = await sharp(png).resize({ width: o.smallWidth }).webp({ quality: 60 }).toBuffer();
  const thumb = await sharp(png).resize({ width: o.thumbWidth }).webp({ quality: 50 }).toBuffer();
  return { full, small, thumb, width: o.fullWidth, height: Math.round(((meta.height ?? 1) / (meta.width ?? 1)) * o.fullWidth) };
}

/**
 * Haqiqiy renderer: pdfjs-dist 3.11.174 (Apache-2.0, CommonJS "legacy" build) + @napi-rs/canvas (MIT, tayyor binar).
 * XAVFSIZLIK: isEvalSupported=false (pdf.js 4.2.67 dan oldingi versiyalardagi eval zaifligini yopadi), fontlar tizimdan emas, JavaScript/skriptlar bajarilmaydi.
 * HOLAT: kichik sinov PDF'lari bilan sinalgan; katta/murakkab PDF'lar, xotira va vaqt chegaralari haqiqiy fayllarda o'lchanmagan.
 */
export class PdfJsRenderer implements PdfRenderer {
  readonly name = 'pdfjs';

  async render(pdf: Buffer, o: RenderOptions, onPage: (p: RenderedPage) => Promise<void>, onCount?: (n: number) => Promise<void>) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const canvasLib = require('@napi-rs/canvas');
    const { createCanvas } = canvasLib;
    // pdf.js Node'da 'canvas' paketini qidiradi; o'rniga @napi-rs/canvas global obyektlarini beramiz
    const g = globalThis as any;
    for (const k of ['DOMMatrix', 'Path2D', 'ImageData']) if (!g[k] && canvasLib[k]) g[k] = canvasLib[k];
    const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
    class CanvasFactory {
      create(width: number, height: number) {
        const canvas = createCanvas(Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)));
        return { canvas, context: canvas.getContext('2d') };
      }
      reset(c: any, width: number, height: number) {
        c.canvas.width = Math.max(1, Math.ceil(width));
        c.canvas.height = Math.max(1, Math.ceil(height));
      }
      destroy(c: any) {
        c.canvas.width = 0;
        c.canvas.height = 0;
      }
    }
    const factory = new CanvasFactory();
    let doc: any;
    try {
      doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0, canvasFactory: factory, enableXfa: false }).promise;
    } catch (e: any) {
      throw new RenderError(e?.name === 'PasswordException' ? 'encrypted' : 'render_failed', e?.message);
    }
    try {
      const n: number = doc.numPages;
      if (n > o.maxPages) throw new RenderError('too_many_pages');
      await onCount?.(n);
      for (let i = 1; i <= n; i++) {
        if (Date.now() > o.deadlineMs) throw new RenderError('timeout');
        const page = await doc.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: o.fullWidth / base.width });
        const c = factory.create(viewport.width, viewport.height);
        try {
          await page.render({ canvasContext: c.context, viewport, canvasFactory: factory }).promise;
          const enc = await encode(c.canvas.toBuffer('image/png'), o);
          await onPage({ page: i, ...enc });
        } finally {
          factory.destroy(c);
          page.cleanup();
        }
      }
      return { pageCount: n };
    } catch (e) {
      if (e instanceof RenderError) throw e;
      throw new RenderError('render_failed', (e as Error).message);
    } finally {
      await doc.destroy().catch(() => undefined);
    }
  }
}

/** Test renderer: haqiqiy PDF o'qimaydi; belgilangan sonli bir xil rangli sahifalar yaratadi (sahifalar soni PDF ichidagi "/Type /Page" lar bo'yicha yoki `pages`). */
export class FakePdfRenderer implements PdfRenderer {
  readonly name = 'fake';
  failNext = false;
  calls = 0;
  constructor(private pages?: number) {}

  async render(pdf: Buffer, o: RenderOptions, onPage: (p: RenderedPage) => Promise<void>, onCount?: (n: number) => Promise<void>) {
    this.calls++;
    if (this.failNext) {
      this.failNext = false;
      throw new RenderError('render_failed', 'forced');
    }
    const counted = pdf.toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 1;
    const n = this.pages ?? counted;
    if (n > o.maxPages) throw new RenderError('too_many_pages');
    await onCount?.(n);
    for (let i = 1; i <= n; i++) {
      if (Date.now() > o.deadlineMs) throw new RenderError('timeout');
      const png = await sharp({ create: { width: 100, height: 140, channels: 3, background: { r: (i * 40) % 255, g: 120, b: 200 } } }).png().toBuffer();
      await onPage({ page: i, ...(await encode(png, o)) });
    }
    return { pageCount: n };
  }
}

export function createPdfRenderer(env: NodeJS.ProcessEnv = process.env): PdfRenderer {
  const kind = (env.PDF_RENDERER || (env.NODE_ENV === 'test' ? 'fake' : 'pdfjs')).toLowerCase();
  if (kind === 'pdfjs') return new PdfJsRenderer();
  if (kind === 'fake') {
    if (env.NODE_ENV === 'production') throw new Error('The fake PDF renderer must not be used in production');
    return new FakePdfRenderer();
  }
  throw new Error(`Unknown PDF_RENDERER "${kind}"`);
}
