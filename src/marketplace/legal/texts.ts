// QORALAMA — YURIST KO'RIB CHIQISHI SHART (draft, needs legal review). Bu matnlar huquqiy maslahat EMAS.
// Matn faqat hozirgi KOD NIMA QILISHINI tasvirlaydi. Shifrlash/xavfsizlik haqida isbotlanmagan da'volar yo'q.
// Ochiq masalalar: LAWYER_QUESTIONS.md.

export type LegalLocale = 'uz' | 'ru' | 'en';
export interface LegalSection {
  heading: string;
  body: string;
}
export interface LegalDoc {
  title: string;
  draftBanner: string;
  sections: LegalSection[];
}

export const CURRENT_VERSIONS = {
  TERMS: '2026-10-draft-1',
  PRIVACY: '2026-10-draft-1',
  GUARDIAN_STATEMENT: '2026-10-draft-1',
} as const;

const BANNER: Record<LegalLocale, string> = {
  uz: "QORALAMA — yuridik ko'rib chiqishdan o'tmagan. Hali kuchga kirmagan.",
  ru: 'ЧЕРНОВИК — не прошёл юридическую проверку. Ещё не вступил в силу.',
  en: 'DRAFT — has not had legal review. Not yet in force.',
};

export const LEGAL_TEXTS: Record<'terms' | 'privacy', Record<LegalLocale, LegalDoc>> = {
  terms: {
    en: {
      title: 'Terms of Use (draft)',
      draftBanner: BANNER.en,
      sections: [
        { heading: '1. What School17 is', body: 'School17 is a platform where teachers offer lessons and pupils (or the parents/guardians of pupils under 18) find teachers, book lessons, talk by video, exchange messages and files. School17 is not the teacher and does not guarantee results.' },
        { heading: '2. Accounts and age', body: 'You must give a correct date of birth. Users under 13 cannot register. Users aged 13-17 need a linked parent/guardian: a guardian books lessons and pays the teacher directly, can read the pupil\'s chats (read-only) and can block teachers. We cannot verify that a guardian is a real parent; see the guardian statement. Teachers must be adults and are listed only after an administrator verifies their profile and documents.' },
        { heading: '3. Bookings and cancellations', body: 'A booking is confirmed instantly or after the teacher accepts it. Please cancel as early as you can and tell the other side why. Rescheduling needs the other side\'s consent.' },
        { heading: '4. Payments (School17 is free)', body: 'School17 is free. It does not handle, hold or guarantee payments; pupils pay teachers directly. Agree the price and when to pay with the teacher; pupils usually send a card transfer in their own banking app. The teacher\'s card details are shown only to pupils who booked a lesson. The app can show whether a lesson is marked paid by the pupil or confirmed by the teacher, but it cannot check, protect or recover any payment, and cannot return money. Compare the card holder name with your bank app before sending, never share a card CVV or SMS code, and report payment problems.' },
        { heading: '5. Video lessons', body: 'Lessons run inside the app within a join window around the booked time. Lessons are NOT recorded. Recording is only possible with the consent of every participant and never when a minor takes part (feature not yet available). Do not record lessons yourself without everyone\'s consent.' },
        { heading: '6. Messages and files', body: 'Messages and files are sent over encrypted connections (HTTPS) and are stored on our servers; they are not end-to-end encrypted and administrators can review reported content. Allowed files: JPEG, PNG, WebP and PDF. Photos are re-encoded and location/camera metadata is removed. We cannot guarantee that files are free of malware.' },
        { heading: '7. Safety rules', body: 'No sharing of contact details with pupils under 18, no moving the conversation to other apps, no gifts, no meeting in person, no harassment, discrimination, sexual or violent content, or illegal content. You can block and report users and messages. We may suspend accounts and report serious cases to the authorities.' },
        { heading: '8. Reviews', body: 'Only the person who booked a completed lesson can review it, once. Reviews must be honest and respectful. Teachers may reply once. Reported reviews may be hidden by moderators.' },
        { heading: '9. Your content and our rights', body: 'You keep your rights to the content you upload. You allow us to store and show it as needed to run the service. We may remove content that breaks these rules.' },
        { heading: '10. Termination and deletion', body: 'You can delete your account. Some records (safety reports, audit logs) are kept as required by law or for dispute handling, see the Privacy Policy.' },
        { heading: '11. Liability and changes', body: 'The service is provided "as is" to the extent allowed by law. We may update these terms; you will be asked to accept important changes. [Governing law and dispute resolution: to be completed by a lawyer.]' },
      ],
    },
    ru: {
      title: 'Условия использования (черновик)',
      draftBanner: BANNER.ru,
      sections: [
        { heading: '1. Что такое School17', body: 'School17 — платформа, где преподаватели проводят занятия, а ученики (или родители/опекуны учеников до 18 лет) находят преподавателей, бронируют уроки, общаются по видео, обмениваются сообщениями и файлами. School17 не является преподавателем и не гарантирует результат.' },
        { heading: '2. Аккаунты и возраст', body: 'Укажите верную дату рождения. Пользователи младше 13 лет не могут зарегистрироваться. Для пользователей 13–17 лет нужен привязанный родитель/опекун: опекун бронирует уроки и платит преподавателю напрямую, может читать переписку ученика (только чтение) и блокировать преподавателей. Мы не можем проверить, что опекун — действительно родитель; см. заявление опекуна. Преподаватели должны быть совершеннолетними и отображаются только после проверки профиля и документов администратором.' },
        { heading: '3. Бронирование и отмена', body: 'Бронь подтверждается сразу или после согласия преподавателя. Отменяйте как можно раньше и сообщите второй стороне причину. Для переноса нужно согласие второй стороны.' },
        { heading: '4. Платежи (School17 бесплатен)', body: 'School17 бесплатен. Он не принимает, не удерживает и не гарантирует платежи; ученики платят преподавателям напрямую. Цену и срок оплаты согласуйте с преподавателем; обычно ученик переводит деньги на карту в своём банковском приложении. Данные карты преподавателя видны только ученикам, забронировавшим урок. Приложение может показывать отметку «оплачено» от ученика или «получено» от преподавателя, но не проверяет, не защищает, не возвращает и не взыскивает платежи. Сверяйте имя владельца карты с банковским приложением, никогда не сообщайте CVV и коды из SMS, сообщайте о проблемах с оплатой.' },
        { heading: '5. Видеоуроки', body: 'Уроки проходят в приложении в окне подключения вокруг времени брони. Уроки НЕ записываются. Запись возможна только с согласия всех участников и никогда — если участвует несовершеннолетний (функция пока недоступна). Не записывайте уроки самостоятельно без согласия всех.' },
        { heading: '6. Сообщения и файлы', body: 'Сообщения и файлы передаются по защищённому соединению (HTTPS) и хранятся на наших серверах; они не имеют сквозного шифрования, а администраторы могут просматривать контент, на который пожаловались. Разрешены файлы JPEG, PNG, WebP и PDF. Фото перекодируются, метаданные съёмки и геолокации удаляются. Мы не можем гарантировать отсутствие вредоносного кода в файлах.' },
        { heading: '7. Правила безопасности', body: 'Нельзя передавать контакты ученикам младше 18 лет, переводить общение в другие приложения, дарить подарки, встречаться лично, оскорблять, дискриминировать, публиковать сексуальный, жестокий или незаконный контент. Вы можете блокировать пользователей и жаловаться на пользователей и сообщения. Мы можем блокировать аккаунты и сообщать о серьёзных случаях в компетентные органы.' },
        { heading: '8. Отзывы', body: 'Отзыв может оставить только тот, кто забронировал завершённый урок, один раз. Отзывы должны быть честными и вежливыми. Преподаватель может ответить один раз. Отзывы, на которые пожаловались, модераторы могут скрыть.' },
        { heading: '9. Ваш контент и наши права', body: 'Права на загруженный вами контент остаются у вас. Вы разрешаете нам хранить и показывать его в объёме, необходимом для работы сервиса. Мы можем удалить контент, нарушающий правила.' },
        { heading: '10. Прекращение и удаление', body: 'Вы можете удалить аккаунт. Часть записей (жалобы, журналы действий) сохраняется по закону или для разрешения споров, см. Политику конфиденциальности.' },
        { heading: '11. Ответственность и изменения', body: 'Сервис предоставляется «как есть» в пределах, допустимых законом. Мы можем обновлять условия; о важных изменениях вас попросят подтвердить согласие. [Применимое право и разрешение споров: должен дополнить юрист.]' },
      ],
    },
    uz: {
      title: "Foydalanish shartlari (qoralama)",
      draftBanner: BANNER.uz,
      sections: [
        { heading: '1. School17 nima', body: "School17 — o'qituvchilar dars o'tadigan, o'quvchilar (yoki 18 yoshgacha o'quvchilarning ota-onasi/vasiysi) esa o'qituvchi topadigan, dars bron qiladigan, video orqali gaplashadigan, xabar va fayl almashadigan platforma. School17 o'qituvchi emas va natijani kafolatlamaydi." },
        { heading: '2. Akkaunt va yosh', body: "To'g'ri tug'ilgan sanani kiriting. 13 yoshgacha bo'lganlar ro'yxatdan o'ta olmaydi. 13–17 yoshdagilar uchun bog'langan ota-ona/vasiy kerak: vasiy dars bron qiladi va o'qituvchiga to'g'ridan-to'g'ri to'laydi, o'quvchining yozishmalarini o'qiy oladi (faqat o'qish) va o'qituvchilarni bloklay oladi. Vasiyning haqiqatan ota-ona ekanini tekshira olmaymiz; vasiy bayonotiga qarang. O'qituvchilar voyaga yetgan bo'lishi shart va faqat administrator profil hamda hujjatlarni tekshirgandan so'ng ko'rsatiladi." },
        { heading: '3. Bron va bekor qilish', body: "Bron darhol yoki o'qituvchi qabul qilgach tasdiqlanadi. Iloji boricha erta bekor qiling va ikkinchi tomonga sababini yozing. Ko'chirish uchun ikkinchi tomonning roziligi kerak." },
        { heading: '4. To‘lovlar (School17 bepul)', body: "School17 bepul. U to'lovlarni qabul qilmaydi, ushlab turmaydi va kafolatlamaydi; o'quvchilar o'qituvchiga to'g'ridan-to'g'ri to'laydi. Narx va to'lov vaqtini o'qituvchi bilan kelishing; odatda o'quvchi o'z bank ilovasida kartaga o'tkazma qiladi. O'qituvchining karta ma'lumotlari faqat dars bron qilgan o'quvchilarga ko'rsatiladi. Ilova darsni o'quvchi «to'ladim» yoki o'qituvchi «oldim» deb belgilaganini ko'rsatishi mumkin, lekin to'lovni tekshirmaydi, himoya qilmaydi, qaytarmaydi va undirmaydi. Yuborishdan oldin karta egasining ismini bank ilovangiz bilan solishtiring, CVV va SMS kodlarni hech kimga bermang, to'lov muammosini xabar qiling." },
        { heading: '5. Video darslar', body: "Darslar ilova ichida, bron vaqti atrofidagi qo'shilish oynasida o'tadi. Darslar yozib OLINMAYDI. Yozib olish faqat barcha ishtirokchilarning roziligi bilan va voyaga yetmagan ishtirok etsa hech qachon mumkin emas (funksiya hali yo'q). Hamma rozi bo'lmasa, o'zingiz ham yozib olmang." },
        { heading: '6. Xabar va fayllar', body: "Xabar va fayllar himoyalangan ulanish (HTTPS) orqali uzatiladi va bizning serverlarda saqlanadi; ular boshdan-oxir shifrlanmagan, shikoyat qilingan kontentni administratorlar ko'ra oladi. Ruxsat etilgan fayllar: JPEG, PNG, WebP va PDF. Rasmlar qayta kodlanadi, suratga olish va joylashuv metama'lumotlari o'chiriladi. Fayllarda zararli dastur yo'qligini kafolatlay olmaymiz." },
        { heading: '7. Xavfsizlik qoidalari', body: "18 yoshgacha o'quvchilarga aloqa ma'lumotlarini berish, suhbatni boshqa ilovalarga ko'chirish, sovg'a berish, yuzma-yuz uchrashish, haqorat, kamsitish, jinsiy, zo'ravon yoki noqonuniy kontent taqiqlanadi. Foydalanuvchilar va xabarlarni bloklash hamda ular haqida shikoyat qilish mumkin. Akkauntlarni to'xtatib, jiddiy holatlarni vakolatli organlarga xabar qilishimiz mumkin." },
        { heading: '8. Sharhlar', body: "Sharhni faqat yakunlangan darsni bron qilgan shaxs, bir marta qoldira oladi. Sharhlar halol va hurmatli bo'lishi kerak. O'qituvchi bir marta javob yozishi mumkin. Shikoyat qilingan sharhni moderatorlar yashirishi mumkin." },
        { heading: '9. Kontent va huquqlar', body: "Yuklagan kontentingizga huquq sizda qoladi. Xizmat ishlashi uchun zarur darajada uni saqlash va ko'rsatishga ruxsat berasiz. Qoidalarni buzgan kontentni o'chirishimiz mumkin." },
        { heading: '10. Tugatish va o‘chirish', body: "Akkauntingizni o'chirishingiz mumkin. Ba'zi yozuvlar (shikoyatlar, harakatlar jurnali) qonun talabi yoki nizolarni hal qilish uchun saqlanadi, Maxfiylik siyosatiga qarang." },
        { heading: '11. Javobgarlik va o‘zgarishlar', body: "Xizmat qonun ruxsat bergan doirada «borligicha» taqdim etiladi. Shartlarni yangilashimiz mumkin; muhim o'zgarishlarda rozilik so'raladi. [Qo'llaniladigan huquq va nizolarni hal qilish: yurist to'ldirishi kerak.]" },
      ],
    },
  },
  privacy: {
    en: {
      title: 'Privacy Policy (draft)',
      draftBanner: BANNER.en,
      sections: [
        { heading: '1. Who we are', body: '[Operator name, registered address and contact for privacy requests: to be completed.]' },
        { heading: '2. Data we process', body: 'Account: email or phone number, name, role, date of birth, language, timezone, photo. Contacts (only if you allow it): the phone scrambles each number and sends only the scrambled values to show which friends already use the app; the list itself is not stored. Notifications: a push token for your device. Learning activity: topic test scores, votes, streak and class ranking, and the public comments and star ratings you write. Teachers: profile text, face photo, experience, education, city, subjects, prices, availability, intro-video link, credential documents, videos they add to topics. Lessons: bookings, call attendance times and connection-quality statistics (not audio/video). Messages: text and attached files. Teacher payment card: the card number (stored encrypted) and holder name, shown only to pupils whose lesson the teacher accepted. Safety: reports, blocks, consents, audit logs. Technical: IP address and device information in server logs.' },
        { heading: '3. Why (purposes)', body: 'To run the marketplace (bookings, video lessons, messaging, payments), to keep pupils safe (moderation, age rules), to prevent fraud, to meet legal duties and to improve reliability. [Legal basis per purpose: to be completed by a lawyer.]' },
        { heading: '4. Children', body: 'Users aged 13-17 can use the service only with a linked guardian. Guardians can see the pupil\'s chat history (read-only). We do not record lessons and do not allow recording when a minor takes part. We do not knowingly allow children under 13.' },
        { heading: '5. Who sees what', body: 'Teachers see a pupil\'s display name (for minors: first name and surname initial) and messages in their conversation, never the pupil\'s email, date of birth or user id. Pupils see teacher profiles. Administrators see reports and may open reported content and credential documents; these accesses are logged. Video/audio is transmitted by our video provider; see "Providers".' },
        { heading: '6. Providers and locations', body: 'Video: LiveKit (self-hosted or cloud, to be decided). Storage, database, email and push providers: [to be listed]. [Where each provider stores data, and whether data must stay in Uzbekistan: NEEDS LAWYER, see LAWYER_QUESTIONS.md.]' },
        { heading: '7. Security measures', body: 'Connections use HTTPS/TLS. Access is controlled per user and role; uploaded images are re-encoded and stripped of location metadata; access to files uses short-lived signed links. Messages, files and database contents are NOT end-to-end encrypted. Disk-level encryption depends on the hosting provider [to be confirmed]. No system is perfectly secure.' },
        { heading: '8. Retention', body: 'Account data is kept while the account exists. After deletion we remove or anonymise personal data, except records we must keep (safety reports and audit logs) for [period to be set by a lawyer]. Pending uploads are removed after 24 hours.' },
        { heading: '9. Your rights', body: 'You can download your data, correct your profile, withdraw optional consents and delete your account in the app. For other requests contact us at [contact].' },
        { heading: '10. Changes', body: 'We will tell you about important changes and ask for consent where required.' },
      ],
    },
    ru: {
      title: 'Политика конфиденциальности (черновик)',
      draftBanner: BANNER.ru,
      sections: [
        { heading: '1. Кто мы', body: '[Название оператора, адрес и контакт для запросов по данным: будет добавлено.]' },
        { heading: '2. Какие данные мы обрабатываем', body: 'Аккаунт: email или номер телефона, имя, роль, дата рождения, язык, часовой пояс, фото. Контакты (только если вы разрешили): телефон «перемешивает» каждый номер и отправляет только такие значения, чтобы показать, какие друзья уже в приложении; сам список не сохраняется. Уведомления: push-токен вашего устройства. Учебная активность: результаты тестов по темам, голоса, серия и рейтинг в классе, а также публичные комментарии и оценки, которые вы пишете. Преподаватели: текст профиля, фото лица, опыт, образование, город, предметы, цены, расписание, ссылка на видео, документы о квалификации, видео, добавленные к темам. Уроки: брони, время присутствия на звонке и статистика качества соединения (не аудио/видео). Сообщения: текст и вложенные файлы. Платёжная карта преподавателя: номер (хранится в зашифрованном виде) и имя владельца; видны только ученикам, чей урок преподаватель принял. Безопасность: жалобы, блокировки, согласия, журналы действий. Технические: IP-адрес и сведения об устройстве в журналах сервера.' },
        { heading: '3. Зачем (цели)', body: 'Для работы платформы (брони, видеоуроки, сообщения, платежи), безопасности учеников (модерация, возрастные правила), предотвращения мошенничества, исполнения законных обязанностей и повышения надёжности. [Правовое основание по каждой цели: должен дополнить юрист.]' },
        { heading: '4. Дети', body: 'Пользователи 13–17 лет могут пользоваться сервисом только с привязанным опекуном. Опекун видит историю переписки ученика (только чтение). Мы не записываем уроки и не допускаем запись при участии несовершеннолетнего. Мы сознательно не допускаем детей младше 13 лет.' },
        { heading: '5. Кто что видит', body: 'Преподаватели видят отображаемое имя ученика (для несовершеннолетних — имя и первая буква фамилии) и сообщения своего диалога, но не email, дату рождения и идентификатор. Ученики видят профили преподавателей. Администраторы видят жалобы и могут открывать контент, на который пожаловались, и документы преподавателей; такие обращения журналируются. Видео/аудио передаёт наш видеопровайдер; см. «Провайдеры».' },
        { heading: '6. Провайдеры и места хранения', body: 'Видео: LiveKit (собственный сервер или облако — будет решено). Хранилище, база данных, email и push: [будет указано]. [Где провайдеры хранят данные и обязаны ли данные оставаться в Узбекистане: НУЖЕН ЮРИСТ, см. LAWYER_QUESTIONS.md.]' },
        { heading: '7. Меры безопасности', body: 'Соединения используют HTTPS/TLS. Доступ ограничен по пользователю и роли; загруженные изображения перекодируются, геометки удаляются; доступ к файлам — по короткоживущим подписанным ссылкам. Сообщения, файлы и содержимое базы данных НЕ имеют сквозного шифрования. Шифрование дисков зависит от хостинга [уточняется]. Абсолютно безопасных систем не бывает.' },
        { heading: '8. Срок хранения', body: 'Данные аккаунта хранятся, пока он существует. После удаления мы удаляем или обезличиваем персональные данные, кроме записей, которые обязаны хранить (жалобы, журналы действий) в течение [срок определит юрист]. Незавершённые загрузки удаляются через 24 часа.' },
        { heading: '9. Ваши права', body: 'В приложении вы можете скачать свои данные, исправить профиль, отозвать необязательные согласия и удалить аккаунт. По другим вопросам пишите: [контакт].' },
        { heading: '10. Изменения', body: 'О важных изменениях мы сообщим и, где нужно, попросим согласие.' },
      ],
    },
    uz: {
      title: 'Maxfiylik siyosati (qoralama)',
      draftBanner: BANNER.uz,
      sections: [
        { heading: '1. Biz kimmiz', body: "[Operator nomi, manzili va maxfiylik so'rovlari uchun aloqa: to'ldiriladi.]" },
        { heading: "2. Qanday ma'lumotlarni qayta ishlaymiz", body: "Akkaunt: email yoki telefon raqami, ism, rol, tug'ilgan sana, til, vaqt zonasi, rasm. Kontaktlar (faqat ruxsat bersangiz): telefon har bir raqamni «aralashtirib» yuboradi va faqat shu qiymatlar yordamida qaysi do'stlaringiz ilovada ekanini ko'rsatadi; ro'yxatning o'zi saqlanmaydi. Bildirishnomalar: qurilmangizning push tokeni. O'quv faoliyati: mavzu testlari natijalari, ovozlar, seriya va sinfdagi reyting hamda siz yozgan ommaviy izohlar va yulduzli baholar. O'qituvchilar: profil matni, yuz rasmi, tajriba, ta'lim, shahar, fanlar, narxlar, jadval, video havola, malaka hujjatlari, mavzularga qo'shgan videolari. Darslar: bronlar, qo'ng'iroqda bo'lgan vaqt va aloqa sifati statistikasi (audio/video emas). Xabarlar: matn va biriktirilgan fayllar. O'qituvchining to'lov kartasi: karta raqami (shifrlangan holda saqlanadi) va egasining ismi; faqat o'qituvchi darsini qabul qilgan o'quvchilarga ko'rsatiladi. Xavfsizlik: shikoyatlar, bloklar, rozilik, harakatlar jurnali. Texnik: server jurnallarida IP-manzil va qurilma ma'lumoti." },
        { heading: '3. Nima uchun (maqsadlar)', body: "Platforma ishlashi (bron, video dars, xabar, to'lov), o'quvchilar xavfsizligi (moderatsiya, yosh qoidalari), firibgarlikning oldini olish, qonuniy majburiyatlar va ishonchlilikni oshirish uchun. [Har bir maqsad bo'yicha huquqiy asos: yurist to'ldiradi.]" },
        { heading: '4. Bolalar', body: "13–17 yoshdagilar xizmatdan faqat bog'langan vasiy bilan foydalana oladi. Vasiy o'quvchining yozishmalar tarixini ko'ra oladi (faqat o'qish). Darslarni yozib olmaymiz va voyaga yetmagan ishtirok etsa yozib olishga ruxsat bermaymiz. 13 yoshgacha bolalarga bila turib ruxsat bermaymiz." },
        { heading: '5. Kim nimani ko‘radi', body: "O'qituvchilar o'quvchining ko'rinadigan ismini (voyaga yetmaganlar uchun: ism va familiya bosh harfi) hamda o'z suhbatidagi xabarlarni ko'radi, lekin o'quvchining emailini, tug'ilgan sanasini va identifikatorini ko'rmaydi. O'quvchilar o'qituvchi profillarini ko'radi. Administratorlar shikoyatlarni ko'radi, shikoyat qilingan kontent va o'qituvchi hujjatlarini ocha oladi; bunday kirishlar jurnalga yoziladi. Video/audioni video provayderimiz uzatadi; «Provayderlar»ga qarang." },
        { heading: '6. Provayderlar va joylashuv', body: "Video: LiveKit (o'z serverimiz yoki bulut — hal qilinadi). Saqlash, ma'lumotlar bazasi, email va push provayderlari: [ko'rsatiladi]. [Provayderlar ma'lumotni qayerda saqlashi va ma'lumot O'zbekistonda qolishi shartmi: YURIST KERAK, LAWYER_QUESTIONS.md ga qarang.]" },
        { heading: '7. Xavfsizlik choralari', body: "Ulanishlar HTTPS/TLS dan foydalanadi. Kirish foydalanuvchi va rol bo'yicha cheklangan; yuklangan rasmlar qayta kodlanadi va joylashuv ma'lumotlari o'chiriladi; fayllarga kirish qisqa muddatli imzolangan havolalar orqali. Xabarlar, fayllar va ma'lumotlar bazasi mazmuni boshdan-oxir shifrlanMAGAN. Disk darajasidagi shifrlash hosting provayderiga bog'liq [aniqlanadi]. Mutlaq xavfsiz tizim yo'q." },
        { heading: '8. Saqlash muddati', body: "Akkaunt ma'lumotlari akkaunt mavjud ekan saqlanadi. O'chirilgach, shaxsiy ma'lumotlarni o'chiramiz yoki anonimlashtiramiz; saqlashga majbur yozuvlar (shikoyatlar, harakatlar jurnali) bundan mustasno — ular [muddatni yurist belgilaydi] saqlanadi. Tugallanmagan yuklashlar 24 soatdan keyin o'chiriladi." },
        { heading: '9. Huquqlaringiz', body: "Ilovada ma'lumotlaringizni yuklab olish, profilni tuzatish, majburiy bo'lmagan rozilikni qaytarib olish va akkauntni o'chirish mumkin. Boshqa so'rovlar uchun: [aloqa]." },
        { heading: '10. O‘zgarishlar', body: "Muhim o'zgarishlar haqida xabar beramiz va kerak bo'lsa rozilik so'raymiz." },
      ],
    },
  },
};

export const GUARDIAN_STATEMENT: Record<LegalLocale, string> = {
  en: 'I confirm that I am the parent or legal guardian of this pupil and that I am at least 18 years old. I agree to the Terms and the Privacy Policy on the pupil\'s behalf, I understand that I can read the pupil\'s chats and that I am responsible for the lessons I book and pay for. (DRAFT: School17 cannot verify guardianship.)',
  ru: 'Подтверждаю, что я родитель или законный представитель этого ученика и мне не менее 18 лет. Я принимаю Условия и Политику конфиденциальности от имени ученика, понимаю, что могу читать переписку ученика, и отвечаю за уроки, которые бронирую и оплачиваю. (ЧЕРНОВИК: School17 не может проверить опеку.)',
  uz: "Men ushbu o'quvchining ota-onasi yoki qonuniy vakili ekanimni va kamida 18 yoshda ekanimni tasdiqlayman. Shartlar va Maxfiylik siyosatini o'quvchi nomidan qabul qilaman, o'quvchining yozishmalarini o'qiy olishimni tushunaman va bron qilgan hamda to'lagan darslar uchun javobgarman. (QORALAMA: School17 vasiylikni tekshira olmaydi.)",
};
