// Bildirishnoma matnlari (uz/ru/en). Matnlar ATAYLAB umumiy: push ekranda xabar mazmuni, ism yoki to'lov summasi ko'rinmaydi
// (qulf ekranida bola xabarlari/pul miqdori oshkor bo'lmasligi uchun). Kalitlar test bilan tekshiriladi: har bir enqueue turi uchun 3 tilda shablon bo'lishi shart.
export type NotifLocale = 'uz' | 'ru' | 'en';
export interface Template {
  title: string;
  body: string;
}

export const TEMPLATES: Record<string, Record<NotifLocale, Template>> = {
  'booking.requested': {
    uz: { title: 'Yangi dars so\'rovi', body: 'Sizga yangi dars so\'rovi keldi. Qabul qiling yoki rad eting.' },
    ru: { title: 'Новая заявка на урок', body: 'Вам пришла новая заявка на урок. Подтвердите или отклоните.' },
    en: { title: 'New lesson request', body: 'You have a new lesson request. Accept or decline it.' },
  },
  'booking.confirmed': {
    uz: { title: 'Dars tasdiqlandi', body: 'Dars tasdiqlandi. Vaqtini "Darslarim" bo\'limida ko\'ring.' },
    ru: { title: 'Урок подтверждён', body: 'Урок подтверждён. Время смотрите в разделе «Мои уроки».' },
    en: { title: 'Lesson confirmed', body: 'Your lesson is confirmed. See the time under "My lessons".' },
  },
  'booking.declined': {
    uz: { title: 'So\'rov rad etildi', body: 'O\'qituvchi dars so\'rovini rad etdi. Boshqa vaqt yoki o\'qituvchi tanlang.' },
    ru: { title: 'Заявка отклонена', body: 'Преподаватель отклонил заявку. Выберите другое время или преподавателя.' },
    en: { title: 'Request declined', body: 'The teacher declined the request. Pick another time or teacher.' },
  },
  'booking.cancelled': {
    uz: { title: 'Dars bekor qilindi', body: 'Dars bekor qilindi. Tafsilotlar ilovada.' },
    ru: { title: 'Урок отменён', body: 'Урок отменён. Подробности в приложении.' },
    en: { title: 'Lesson cancelled', body: 'A lesson was cancelled. Details are in the app.' },
  },
  'booking.expired': {
    uz: { title: 'So\'rov muddati tugadi', body: 'O\'qituvchi javob bermadi, so\'rov bekor bo\'ldi. Boshqa vaqtni tanlang.' },
    ru: { title: 'Срок заявки истёк', body: 'Преподаватель не ответил, заявка отменена. Выберите другое время.' },
    en: { title: 'Request expired', body: 'The teacher did not reply and the request expired. Pick another time.' },
  },
  'booking.reminder': {
    uz: { title: 'Dars eslatmasi', body: 'Dars tez orada boshlanadi. Aloqa va qurilmalaringizni tekshiring.' },
    ru: { title: 'Напоминание об уроке', body: 'Скоро урок. Проверьте связь и устройства.' },
    en: { title: 'Lesson reminder', body: 'Your lesson starts soon. Check your connection and devices.' },
  },
  'booking.reschedule_proposed': {
    uz: { title: 'Ko\'chirish taklifi', body: 'Darsni boshqa vaqtga ko\'chirish taklif qilindi. Javob bering.' },
    ru: { title: 'Предложен перенос', body: 'Предложено перенести урок на другое время. Ответьте.' },
    en: { title: 'Reschedule proposed', body: 'A new time was proposed for your lesson. Please respond.' },
  },
  'directpay.marked': {
    uz: { title: "O'quvchi to'lov qildi deb belgiladi", body: "Dars uchun to'lov belgilandi. Pul tushganini tekshirib, tasdiqlang." },
    ru: { title: 'Ученик отметил оплату', body: 'Оплата за урок отмечена. Проверьте поступление и подтвердите.' },
    en: { title: 'Pupil marked the lesson as paid', body: 'A payment was marked for a lesson. Check your card and confirm.' },
  },
  'directpay.confirmed': {
    uz: { title: "O'qituvchi to'lovni tasdiqladi", body: "O'qituvchi to'lov kelganini tasdiqladi." },
    ru: { title: 'Преподаватель подтвердил оплату', body: 'Преподаватель подтвердил, что оплата получена.' },
    en: { title: 'Teacher confirmed the payment', body: 'The teacher confirmed they received the payment.' },
  },
  'directpay.not_received': {
    uz: { title: "To'lov kelmadi deb belgilandi", body: "O'qituvchi to'lov kelmaganini belgiladi. Tekshirib, kerak bo'lsa qayta belgilang." },
    ru: { title: 'Оплата не получена', body: 'Преподаватель отметил, что оплата не поступила. Проверьте и при необходимости отметьте снова.' },
    en: { title: 'Payment not received', body: 'The teacher marked the payment as not received. Please check and mark it again if needed.' },
  },
  'directpay.waived': {
    uz: { title: "Bu dars bepul", body: "Bu dars uchun to'lov talab qilinmaydi." },
    ru: { title: 'Этот урок бесплатный', body: 'За этот урок платить не нужно.' },
    en: { title: 'This lesson is free', body: 'No payment is needed for this lesson.' },
  },
  'booking.counter_offer': {
    uz: { title: "O'qituvchi boshqa vaqt taklif qildi", body: "O'qituvchi dars uchun boshqa vaqt taklif qildi. Qabul qiling yoki rad eting." },
    ru: { title: 'Преподаватель предложил другое время', body: 'Преподаватель предложил другое время для урока. Примите или отклоните.' },
    en: { title: 'The teacher suggested another time', body: 'The teacher suggested a different time for your lesson. Accept or decline it.' },
  },
  'directpay.reminder': {
    uz: { title: "To'lov haqida eslatma", body: "O'qituvchi o'tgan dars uchun to'lovni eslatdi. Tafsilotlar ilovada." },
    ru: { title: 'Напоминание об оплате', body: 'Преподаватель напомнил об оплате прошедшего урока. Подробности в приложении.' },
    en: { title: 'Payment reminder', body: 'Your teacher reminded you about the payment for a past lesson. See the app for details.' },
  },
  'guardian.linked': {
    uz: { title: 'Vasiy bog\'landi', body: 'Hisobingizga vasiy bog\'landi. U yozishmalaringizni o\'qiy oladi.' },
    ru: { title: 'Опекун привязан', body: 'К вашему аккаунту привязан опекун. Он может читать вашу переписку.' },
    en: { title: 'Guardian linked', body: 'A guardian was linked to your account. They can read your chats.' },
  },
  'message.new': {
    uz: { title: 'Yangi xabar', body: 'Sizga yangi xabar keldi.' },
    ru: { title: 'Новое сообщение', body: 'У вас новое сообщение.' },
    en: { title: 'New message', body: 'You have a new message.' },
  },
  'payment.received': {
    uz: { title: 'To\'lov qabul qilindi', body: 'Dars uchun to\'lov qabul qilindi.' },
    ru: { title: 'Оплата получена', body: 'Оплата за урок получена.' },
    en: { title: 'Payment received', body: 'The payment for a lesson was received.' },
  },
  'payment.on_hold': {
    uz: { title: 'Mablag\' ushlab turilmoqda', body: 'Dars yakunlandi. Mablag\' nizolar uchun qisqa muddat ushlab turiladi.' },
    ru: { title: 'Средства удерживаются', body: 'Урок завершён. Средства кратко удерживаются на случай споров.' },
    en: { title: 'Funds on hold', body: 'The lesson is complete. Funds are held briefly in case of disputes.' },
  },
  'payment.released': {
    uz: { title: 'Mablag\' yechishga tayyor', body: 'Dars uchun mablag\' hisobingizda yechish uchun mavjud.' },
    ru: { title: 'Средства доступны', body: 'Средства за урок доступны для вывода.' },
    en: { title: 'Funds available', body: 'Earnings from a lesson are now available to withdraw.' },
  },
  'payment.refunded': {
    uz: { title: 'Pul qaytarildi', body: 'To\'lovingizning bir qismi yoki hammasi qaytarildi.' },
    ru: { title: 'Возврат средств', body: 'Вам вернули часть или всю сумму оплаты.' },
    en: { title: 'Refund issued', body: 'All or part of your payment was refunded.' },
  },
  'payment.disputed': {
    uz: { title: 'Nizo ochildi', body: 'Dars to\'lovi bo\'yicha nizo ochildi. Administrator ko\'rib chiqadi.' },
    ru: { title: 'Открыт спор', body: 'По оплате урока открыт спор. Его рассмотрит администратор.' },
    en: { title: 'Dispute opened', body: 'A dispute was opened for a lesson payment. An administrator will review it.' },
  },
  'payment.resolved': {
    uz: { title: 'Nizo hal qilindi', body: 'To\'lov bo\'yicha qaror qabul qilindi. Tafsilotlar ilovada.' },
    ru: { title: 'Спор решён', body: 'По платежу принято решение. Подробности в приложении.' },
    en: { title: 'Dispute resolved', body: 'A decision was made about a payment. Details are in the app.' },
  },
  'payout.paid': {
    uz: { title: 'Pul yechish bajarildi', body: 'Yechish so\'rovingiz bo\'yicha to\'lov amalga oshirildi.' },
    ru: { title: 'Выплата выполнена', body: 'Выплата по вашему запросу выполнена.' },
    en: { title: 'Payout sent', body: 'Your payout request was paid.' },
  },
  'payout.rejected': {
    uz: { title: 'Yechish rad etildi', body: 'Yechish so\'rovingiz rad etildi. Mablag\' hisobingizga qaytdi.' },
    ru: { title: 'Выплата отклонена', body: 'Запрос на выплату отклонён. Средства возвращены на баланс.' },
    en: { title: 'Payout rejected', body: 'Your payout request was rejected. The money is back in your balance.' },
  },
  'review.new': {
    uz: { title: 'Yangi sharh', body: 'Sizga yangi sharh qoldirildi.' },
    ru: { title: 'Новый отзыв', body: 'Вам оставили новый отзыв.' },
    en: { title: 'New review', body: 'You received a new review.' },
  },
  'review.reply': {
    uz: { title: 'Sharhingizga javob', body: 'O\'qituvchi sharhingizga javob yozdi.' },
    ru: { title: 'Ответ на отзыв', body: 'Преподаватель ответил на ваш отзыв.' },
    en: { title: 'Reply to your review', body: 'The teacher replied to your review.' },
  },
};

export function render(type: string, locale: string): Template {
  const l: NotifLocale = locale === 'ru' || locale === 'en' ? locale : 'uz';
  return TEMPLATES[type]?.[l] ?? TEMPLATES[type]?.en ?? { title: 'School17', body: '' };
}
