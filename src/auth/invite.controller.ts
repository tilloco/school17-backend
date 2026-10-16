import { Controller, Get, Header, Param } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

/**
 * O'qituvchi yuborgan taklif havolasi: https://<server>/j/<token>. Telefonda ilova ochiladi (school17://join/<token>) va
 * o'quvchi to'g'ridan-to'g'ri o'sha sinfga qo'shiladi. Token bu yerda tekshirilmaydi va hech qayerga saqlanmaydi — sahifa faqat yo'naltiradi.
 */
@Controller('j')
export class InviteController {
  @SkipThrottle()
  @Get(':token')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  page(@Param('token') token: string): string {
    const ok = /^[A-Za-z0-9_-]{8,64}$/.test(token);
    const deep = ok ? `school17://join/${token}` : '';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>School17</title>
<style>body{font-family:system-ui,sans-serif;background:#F4F7F9;color:#0F2A38;margin:0;display:grid;place-items:center;min-height:100vh;text-align:center;padding:24px}
a.b{display:inline-block;margin-top:16px;background:#F28C28;color:#fff;padding:14px 26px;border-radius:14px;font-weight:700;text-decoration:none}</style></head>
<body><main><h1>School17</h1>${ok ? `<p>Opening your class in the School17 app…<br>Sinfingiz School17 ilovasida ochilmoqda…<br>Открываем ваш класс в приложении School17…</p><a class="b" href="${deep}">Open / Ochish / Открыть</a>
<p style="color:#5B7280;font-size:13px;margin-top:24px">School17 is free. The app only keeps the class and the schedule.</p><script>setTimeout(function(){location.href=${JSON.stringify(deep)}},300)</script>` : '<p>This link is not valid.</p>'}</main></body></html>`;
  }
}
