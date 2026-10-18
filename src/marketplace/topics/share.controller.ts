import { Controller, Get, Header, Param } from '@nestjs/common';
import { VerificationStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

function page(o: { title: string; text: string; deep: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)}</title>
<meta property="og:title" content="${esc(o.title)}"><meta property="og:description" content="${esc(o.text)}"><meta property="og:type" content="website"><meta property="og:site_name" content="School17">
<meta name="twitter:card" content="summary"><meta name="robots" content="noindex">
<style>body{font-family:system-ui,sans-serif;background:#0f1218;color:#f3f5f8;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}main{max-width:420px;padding:28px;text-align:center}h1{font-size:24px;margin:0 0 10px}p{color:#aab3c2;line-height:1.5}a{display:inline-block;margin-top:18px;background:#1a8cff;color:#fff;text-decoration:none;font-weight:700;padding:14px 26px;border-radius:999px}</style>
</head><body><main><h1>${esc(o.title)}</h1><p>${esc(o.text)}</p><a href="${esc(o.deep)}">Open in School17</a></main></body></html>`;
}

/** Public link previews for sharing in Telegram and elsewhere. Only information that is already public is shown. */
@Controller()
export class ShareController {
  constructor(private prisma: PrismaService) {}

  @Get('p/:id')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
  async teacher(@Param('id') id: string) {
    const ok = /^[0-9a-f-]{36}$/i.test(id);
    const p = ok ? await this.prisma.teacherProfile.findFirst({ where: { id, verificationStatus: VerificationStatus.VERIFIED, user: { status: 'ACTIVE' } }, select: { headline: true, user: { select: { name: true } } } }) : null;
    if (!p) return page({ title: 'School17', text: 'Free tutoring: find a verified teacher and learn.', deep: 'school17://' });
    return page({ title: `${p.user.name ?? 'Teacher'} · School17`, text: p.headline || 'Verified teacher on School17', deep: `school17://market/teacher/${id}` });
  }

  @Get('t/:slug')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
  async topic(@Param('slug') slug: string) {
    const t = /^[a-z0-9-]{1,60}$/.test(slug) ? await this.prisma.topic.findUnique({ where: { slug }, select: { titles: true, summaries: true } }) : null;
    if (!t) return page({ title: 'School17', text: 'Free tutoring: find a verified teacher and learn.', deep: 'school17://' });
    const titles = t.titles as Record<string, string>;
    const sums = t.summaries as Record<string, string>;
    return page({ title: `${titles.en} · School17`, text: `${sums.en} Take the 1-minute test and see how you score.`, deep: `school17://market/topic/${slug}` });
  }
}
