// Xavfsizlik bo'yicha umumiy maslahatlar (uz/ru/en). DRAFT: bola xavfsizligi bo'yicha mutaxassis va yurist ko'rib chiqishi kerak.
export type TipAudience = 'pupil' | 'guardian' | 'teacher';
export type Locale = 'uz' | 'ru' | 'en';

export const SAFETY_TIPS_DRAFT_NOTE: Record<Locale, string> = {
  uz: "Qoralama: bolalar xavfsizligi mutaxassisi ko'rib chiqishi kerak.",
  ru: 'Черновик: требуется проверка специалистом по безопасности детей.',
  en: 'Draft: needs review by a child-safeguarding specialist.',
};

export const SAFETY_TIPS: Record<TipAudience, Record<Locale, string[]>> = {
  pupil: {
    uz: [
      "Telefon raqamingiz, manzilingiz, maktabingiz yoki parollaringizni hech kimga bermang.",
      "Barcha suhbat va darslar faqat ilova ichida bo'lsin. Boshqa ilovaga o'tishni so'rasa — rad eting va xabar bering.",
      "Sizni noqulay his qildirgan har qanday gap yoki xatti-harakatni «Shikoyat» tugmasi bilan yuboring. Siz javobgar emassiz.",
      "O'qituvchi bilan yuzma-yuz uchrashishga rozi bo'lmang. Pul yoki sovg'a so'rasa, ota-onangizga ayting.",
      "Dars paytida ota-onangiz yaqin joyda bo'lsin.",
    ],
    ru: [
      'Не сообщайте номер телефона, адрес, школу или пароли.',
      'Все общение и занятия — только в приложении. Если просят перейти в другой мессенджер — откажитесь и сообщите нам.',
      'Любые слова или действия, из-за которых вам неловко, отправляйте через кнопку «Пожаловаться». Вы ни в чём не виноваты.',
      'Не соглашайтесь на личные встречи с преподавателем. Если просят деньги или подарки — расскажите родителям.',
      'Во время урока пусть взрослый находится рядом.',
    ],
    en: [
      'Never share your phone number, address, school or passwords.',
      'Keep all chats and lessons inside the app. If someone asks you to move to another app, say no and report it.',
      'Report anything that makes you uncomfortable with the Report button. It is never your fault.',
      'Do not agree to meet a teacher in person. If they ask for money or gifts, tell your parent or guardian.',
      'Have a trusted adult nearby during lessons.',
    ],
  },
  guardian: {
    uz: [
      "Farzandingizning suhbatlarini ilovada ko'ra olasiz (faqat o'qish). Muntazam tekshirib turing.",
      "Dars paytida yaqin joyda bo'ling va kamera/mikrofon sozlamalarini tekshiring.",
      "O'qituvchi platformadan tashqarida bog'lanmoqchi bo'lsa yoki to'lovni ilovadan tashqarida so'rasa — shikoyat qiling.",
      "Shubhali o'qituvchini bloklang: u farzandingizga yozolmaydi va dars bron qila olmaydi.",
      "Darslar yozib olinmaydi; yozib olish voyaga yetmaganlar uchun umuman mumkin emas.",
    ],
    ru: [
      'Вы можете читать переписку ребёнка в приложении (только чтение). Проверяйте её регулярно.',
      'Находитесь рядом во время урока и проверьте настройки камеры и микрофона.',
      'Если преподаватель просит связаться вне платформы или оплатить вне приложения — пожалуйтесь.',
      'Заблокируйте подозрительного преподавателя: он не сможет писать ребёнку и бронировать уроки.',
      'Уроки не записываются; запись с участием несовершеннолетних невозможна.',
    ],
    en: [
      "You can read your child's chats in the app (read-only). Check them regularly.",
      'Stay nearby during lessons and check camera and microphone settings.',
      'If a teacher asks to talk outside the platform or to pay outside the app, report them.',
      'Block a suspicious teacher: they can no longer message your child or accept bookings.',
      'Lessons are not recorded; recording is not possible when a minor takes part.',
    ],
  },
  teacher: {
    uz: [
      "Voyaga yetmagan o'quvchilar bilan faqat ilova ichida va faqat dars mavzusida muloqot qiling.",
      "Telefon, ijtimoiy tarmoq yoki shaxsiy ma'lumot so'ramang va bermang; tizim bunday xabarlarni to'sadi.",
      "O'quvchi bilan yuzma-yuz uchrashmang, sovg'a yoki pul qabul qilmang.",
      "Xavotirli holatni ko'rsangiz (zo'ravonlik, o'z joniga qasd qilish haqidagi gaplar) darhol «Shikoyat» orqali xabar bering va platforma qoidalariga amal qiling.",
    ],
    ru: [
      'С несовершеннолетними общайтесь только в приложении и только по теме занятий.',
      'Не просите и не сообщайте телефон, соцсети или личные данные; система блокирует такие сообщения.',
      'Не встречайтесь с учеником лично, не принимайте подарки или деньги.',
      'Если видите тревожные признаки (насилие, разговоры о самоповреждении) — немедленно сообщите через «Пожаловаться».',
    ],
    en: [
      'Talk with minors only inside the app and only about the lesson.',
      'Do not ask for or share phone numbers, social media or personal data; the system blocks such messages.',
      'Do not meet pupils in person and do not accept gifts or money.',
      'If you notice warning signs (abuse, talk of self-harm), report immediately via Report.',
    ],
  },
};
