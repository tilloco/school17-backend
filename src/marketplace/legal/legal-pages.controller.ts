import { Controller, Get, Header, Headers, Query } from '@nestjs/common';
import { LEGAL_TEXTS, LegalLocale } from './texts';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const pickLang = (q?: string, accept?: string): LegalLocale => {
  const l = (q ?? accept ?? '').toLowerCase().slice(0, 2);
  return l === 'ru' || l === 'en' || l === 'uz' ? l : 'en';
};

/** What the draft texts leave open is filled from the server settings: the contact address and the retention period. Anything still unset stays visibly bracketed. */
function fill(text: string): string {
  const contact = process.env.SUPPORT_EMAIL?.trim();
  const period = process.env.LEGAL_RETENTION?.trim();
  let out = text;
  if (contact) out = out.split('[contact]').join(contact);
  if (period) out = out.split('[period to be set by a lawyer]').join(period);
  const operator = process.env.LEGAL_OPERATOR?.trim(); // legal name, registered address and privacy contact
  if (operator) out = out.split('[Operator name, registered address and contact for privacy requests: to be completed.]').join(operator);
  return out;
}

const DELETE_PAGE: Record<LegalLocale, { title: string; intro: string; blocks: { h: string; p: string }[] }> = {
  en: {
    title: 'Delete your School17 account',
    intro: 'You can delete your account and personal data yourself, at any time, inside the app. This page explains how, what is removed and what is kept.',
    blocks: [
      { h: 'In the app', p: 'Open School17, go to Settings, choose "Sign out and delete account", then "Delete account" and confirm. Your account is closed right away and you are signed out. Open lessons or unsettled agreements must be finished first; the app tells you which.' },
      { h: 'What is deleted', p: 'Your name, photo, date of birth, profile text, the content of your messages, files you uploaded, notifications, push tokens, links to guardians, your test scores, votes and public comments, and (for teachers) the profile, diplomas and videos you added.' },
      { h: 'What is kept', p: 'Records we must keep for safety and disputes: safety reports, audit logs, proof of consents and lesson and agreement records. They no longer show your name or contact details. Star ratings you gave stay as numbers so a teacher\'s average is not distorted. Retention periods are in the Privacy Policy.' },
      { h: 'If you cannot open the app', p: 'Write to [contact] from the e-mail address or tell us the phone number of the account, and we will delete it after confirming it is you.' },
    ],
  },
  ru: {
    title: 'Удаление аккаунта School17',
    intro: 'Вы можете сами удалить аккаунт и личные данные в любой момент в приложении. Здесь описано, как это сделать, что удаляется и что сохраняется.',
    blocks: [
      { h: 'В приложении', p: 'Откройте School17, перейдите в «Настройки», выберите «Выйти и удалить аккаунт», затем «Удалить аккаунт» и подтвердите. Аккаунт закрывается сразу, вы выходите из приложения. Незавершённые занятия и договорённости нужно закрыть заранее; приложение подскажет, какие.' },
      { h: 'Что удаляется', p: 'Имя, фото, дата рождения, текст профиля, содержимое ваших сообщений, загруженные файлы, уведомления, push-токены, связи с опекунами, ваши результаты тестов, голоса и публичные комментарии, а для преподавателей — профиль, дипломы и добавленные видео.' },
      { h: 'Что сохраняется', p: 'Записи, которые нужно хранить для безопасности и споров: жалобы по безопасности, журналы аудита, подтверждения согласий, записи о занятиях и договорённостях. В них больше нет вашего имени и контактов. Оценки-звёзды остаются как числа, чтобы не искажать средний балл преподавателя. Сроки хранения указаны в Политике конфиденциальности.' },
      { h: 'Если нет доступа к приложению', p: 'Напишите на [contact] с адреса почты аккаунта или укажите номер телефона аккаунта, и мы удалим его после подтверждения, что это вы.' },
    ],
  },
  uz: {
    title: 'School17 hisobini o‘chirish',
    intro: 'Hisobingizni va shaxsiy ma’lumotlaringizni istalgan vaqtda ilovaning o‘zida o‘zingiz o‘chira olasiz. Bu sahifada qanday qilish, nima o‘chirilishi va nima saqlanishi yozilgan.',
    blocks: [
      { h: 'Ilovada', p: 'School17 ni oching, "Sozlamalar" ga o‘ting, "Chiqish va hisobni o‘chirish" ni tanlang, so‘ng "Hisobni o‘chirish" ni bosib tasdiqlang. Hisob darhol yopiladi va tizimdan chiqasiz. Tugallanmagan darslar yoki kelishuvlarni oldin yakunlash kerak; ilova qaysilari ekanini aytadi.' },
      { h: 'Nima o‘chiriladi', p: 'Ismingiz, rasmingiz, tug‘ilgan sanangiz, profil matni, xabarlaringiz mazmuni, yuklagan fayllaringiz, bildirishnomalar, push tokenlar, vasiy bilan bog‘lanishlar, test natijalaringiz, ovozlaringiz va ommaviy izohlaringiz, o‘qituvchilar uchun esa profil, diplomlar va qo‘shgan videolar.' },
      { h: 'Nima saqlanadi', p: 'Xavfsizlik va nizolar uchun saqlashimiz shart yozuvlar: xavfsizlik shikoyatlari, audit jurnallari, rozilik isbotlari, dars va kelishuv yozuvlari. Ularda endi ismingiz va aloqa ma’lumotlaringiz ko‘rinmaydi. Qo‘ygan yulduzli baholaringiz raqam sifatida qoladi, shunda ustozning o‘rtacha bahosi buzilmaydi. Saqlash muddatlari Maxfiylik siyosatida.' },
      { h: 'Ilovani ocha olmasangiz', p: '[contact] manziliga hisobdagi e-pochtadan yozing yoki hisobning telefon raqamini ayting; sizligingizni tasdiqlab, hisobni o‘chiramiz.' },
    ],
  },
};

function render(o: { title: string; banner?: string; sections: { h: string; p: string }[]; lang: LegalLocale; path: string }): string {
  const langs = (['uz', 'ru', 'en'] as const).map((l) => `<a href="${o.path}?lang=${l}"${l === o.lang ? ' class="on"' : ''}>${l.toUpperCase()}</a>`).join(' ');
  const body = o.sections.map((s) => `<h2>${esc(s.h)}</h2><p>${esc(fill(s.p)).replace(/\n/g, '<br>')}</p>`).join('');
  const nav = ['privacy', 'terms', 'delete-account'].map((p) => `<a href="/${p}?lang=${o.lang}">${p}</a>`).join(' · ');
  return `<!doctype html><html lang="${o.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.title)} · School17</title><meta name="robots" content="index">
<style>body{font-family:system-ui,sans-serif;line-height:1.6;color:#1b2430;margin:0;background:#fff}main{max-width:760px;margin:0 auto;padding:24px 18px 64px}h1{font-size:28px;margin:8px 0 4px}h2{font-size:19px;margin:26px 0 6px}p{margin:0;color:#364152}.top{display:flex;justify-content:space-between;align-items:center;font-size:14px}a{color:#0a66d6}.on{font-weight:700;text-decoration:none;color:#1b2430}.banner{background:#fff4d6;border:1px solid #f0d58a;border-radius:10px;padding:10px 14px;margin:14px 0;font-size:14px}.nav{margin-top:40px;font-size:14px;color:#6b7686}</style>
</head><body><main><div class="top"><strong>School17</strong><span>${langs}</span></div><h1>${esc(o.title)}</h1>${o.banner ? `<div class="banner">${esc(o.banner)}</div>` : ''}${body}<div class="nav">${nav}</div></main></body></html>`;
}

/** Public web pages Google Play asks for: the privacy policy, the terms and how to delete an account. Served from the texts the app shows. */
@Controller()
export class LegalPagesController {
  private doc(kind: 'privacy' | 'terms', lang: LegalLocale) {
    const d = LEGAL_TEXTS[kind][lang];
    return render({ title: d.title.replace(/\s*\(draft\)/i, ''), banner: process.env.LEGAL_REVIEWED === '1' ? undefined : d.draftBanner, sections: d.sections.map((s) => ({ h: s.heading, p: s.body })), lang, path: `/${kind}` });
  }

  @Get('privacy')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
  privacy(@Query('lang') q?: string, @Headers('accept-language') a?: string) { return this.doc('privacy', pickLang(q, a)); }

  @Get('terms')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
  terms(@Query('lang') q?: string, @Headers('accept-language') a?: string) { return this.doc('terms', pickLang(q, a)); }

  @Get('delete-account')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
  deleteAccount(@Query('lang') q?: string, @Headers('accept-language') a?: string) {
    const lang = pickLang(q, a);
    const d = DELETE_PAGE[lang];
    return render({ title: d.title, sections: [{ h: '', p: d.intro }, ...d.blocks], lang, path: '/delete-account' });
  }
}
