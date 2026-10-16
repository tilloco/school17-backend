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
    return landing(ok ? `school17://join/${token}` : '', 'Opening your class in the School17 app…<br>Sinfingiz School17 ilovasida ochilmoqda…<br>Открываем ваш класс в приложении School17…');
  }
}

/** Tiny public endpoint the app calls every few seconds to measure the connection (round-trip time) and to notice when the server cannot be reached. Returns no data. */
@Controller('ping')
export class PingController {
  @SkipThrottle()
  @Get()
  @Header('Cache-Control', 'no-store')
  ping() {
    return { ok: true };
  }
}

/** Teacher profile link to share on Telegram: https://<server>/p/<profileId> opens the teacher's page in the app. */
@Controller('p')
export class ProfileLinkController {
  @SkipThrottle()
  @Get(':id')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  page(@Param('id') id: string): string {
    const ok = /^[0-9a-f-]{36}$/i.test(id);
    return landing(ok ? `school17://market/teacher/${id}` : '', 'Opening the teacher profile in the School17 app…<br>Ustoz profili School17 ilovasida ochilmoqda…<br>Открываем профиль преподавателя в приложении School17…');
  }
}

function landing(deep: string, message: string): string {
  const ok = !!deep;
  {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>School17</title>
<style>body{font-family:system-ui,sans-serif;background:#F4F7F9;color:#0F2A38;margin:0;display:grid;place-items:center;min-height:100vh;text-align:center;padding:24px}
a.b{display:inline-block;margin-top:16px;background:#F28C28;color:#fff;padding:14px 26px;border-radius:14px;font-weight:700;text-decoration:none}</style></head>
<body><main><h1>School17</h1>${ok ? `<p>${message}</p><a class="b" href="${deep}">Open / Ochish / Открыть</a>
<p style="color:#5B7280;font-size:13px;margin-top:24px">School17 is free. The app only keeps the class and the schedule.</p><script>setTimeout(function(){location.href=${JSON.stringify(deep)}},300)</script>` : '<p>This link is not valid.</p>'}</main></body></html>`;
  }
}
