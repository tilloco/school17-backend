// Starter topics for the "Topics" feature: a title and short summary in uz / ru / en and four check questions each.
// Videos are NOT seeded: they are added by verified teachers (a link to YouTube or Vimeo), so every video has a real person behind it.

export type L3 = { uz: string; ru: string; en: string };
export type Opts = string[] | { uz: string[]; ru: string[]; en: string[] };
export interface SeedQuestion { text: L3; options: Opts; correct: number }
export interface SeedTopic { slug: string; subject: string; level: string; title: L3; summary: L3; questions: SeedQuestion[] }

const q = (en: string, ru: string, uz: string, options: Opts, correct: number): SeedQuestion => ({ text: { en, ru, uz }, options, correct });
const o = (en: string[], ru: string[], uz: string[]): Opts => ({ en, ru, uz });

export const SEED_TOPICS: SeedTopic[] = [
  {
    slug: 'fractions', subject: 'math', level: 'grades_5_9',
    title: { en: 'Fractions', ru: 'Дроби', uz: 'Kasrlar' },
    summary: { en: 'Add, compare, simplify and multiply fractions.', ru: 'Сложение, сравнение, сокращение и умножение дробей.', uz: "Kasrlarni qo'shish, solishtirish, qisqartirish va ko'paytirish." },
    questions: [
      q('What is 1/2 + 1/4?', 'Сколько будет 1/2 + 1/4?', '1/2 + 1/4 nechaga teng?', ['2/6', '3/4', '1/6', '2/4'], 1),
      q('Which fraction is the largest?', 'Какая дробь самая большая?', 'Qaysi kasr eng katta?', ['1/3', '1/4', '1/5', '1/2'], 3),
      q('Simplify 6/8.', 'Сократите 6/8.', "6/8 ni qisqartiring.", ['2/3', '4/6', '3/4', '1/2'], 2),
      q('What is 2/3 × 3/4?', 'Сколько будет 2/3 × 3/4?', '2/3 × 3/4 nechaga teng?', ['5/7', '9/8', '1/6', '1/2'], 3),
    ],
  },
  {
    slug: 'percentages', subject: 'math', level: 'grades_5_9',
    title: { en: 'Percentages', ru: 'Проценты', uz: 'Foizlar' },
    summary: { en: 'Find a percent of a number, discounts and percent change.', ru: 'Процент от числа, скидки и изменение в процентах.', uz: "Sonning foizi, chegirmalar va foizdagi o'zgarish." },
    questions: [
      q('What is 10% of 250?', 'Сколько составляет 10% от 250?', '250 ning 10% i nechaga teng?', ['10', '25', '2.5', '50'], 1),
      q('A shirt costs 80. It is 25% off. What is the new price?', 'Рубашка стоит 80. Скидка 25%. Какая новая цена?', "Ko'ylak 80 turadi. 25% chegirma. Yangi narx qancha?", ['55', '65', '60', '20'], 2),
      q('What percent of 60 is 15?', 'Сколько процентов составляет 15 от 60?', "15 soni 60 ning necha foizi?", ['15%', '40%', '20%', '25%'], 3),
      q('A price rises from 200 to 250. By what percent?', 'Цена выросла с 200 до 250. На сколько процентов?', "Narx 200 dan 250 gacha oshdi. Necha foizga?", ['25%', '20%', '50%', '5%'], 0),
    ],
  },
  {
    slug: 'linear-equations', subject: 'math', level: 'grades_5_9',
    title: { en: 'Linear equations', ru: 'Линейные уравнения', uz: 'Chiziqli tenglamalar' },
    summary: { en: 'Solve equations with one unknown step by step.', ru: 'Решение уравнений с одним неизвестным по шагам.', uz: "Bitta noma'lumli tenglamalarni bosqichma-bosqich yechish." },
    questions: [
      q('Solve 2x + 6 = 14.', 'Решите 2x + 6 = 14.', '2x + 6 = 14 ni yeching.', ['x = 4', 'x = 10', 'x = 3', 'x = 8'], 0),
      q('Solve 3x − 5 = 10.', 'Решите 3x − 5 = 10.', '3x − 5 = 10 ni yeching.', ['x = 3', 'x = 5', 'x = 15', 'x = 7'], 1),
      q('If x/4 = 3, what is x?', 'Если x/4 = 3, чему равен x?', 'Agar x/4 = 3 bo‘lsa, x nechaga teng?', ['7', '3/4', '12', '1'], 2),
      q('Solve 5 − x = 2.', 'Решите 5 − x = 2.', '5 − x = 2 ni yeching.', ['x = 7', 'x = −3', 'x = 2', 'x = 3'], 3),
    ],
  },
  {
    slug: 'quadratic-equations', subject: 'math', level: 'grades_10_11',
    title: { en: 'Quadratic equations', ru: 'Квадратные уравнения', uz: 'Kvadrat tenglamalar' },
    summary: { en: 'Roots, factoring and the discriminant.', ru: 'Корни, разложение на множители и дискриминант.', uz: 'Ildizlar, ko‘paytuvchilarga ajratish va diskriminant.' },
    questions: [
      q('How many real roots does x² − 4 = 0 have?', 'Сколько действительных корней у x² − 4 = 0?', 'x² − 4 = 0 tenglamaning nechta haqiqiy ildizi bor?', ['0', '1', '2', '4'], 2),
      q('Find the roots of x² − 5x + 6 = 0.', 'Найдите корни x² − 5x + 6 = 0.', 'x² − 5x + 6 = 0 ning ildizlarini toping.', o(['1 and 6', '2 and 3', '−2 and −3', '5 and 6'], ['1 и 6', '2 и 3', '−2 и −3', '5 и 6'], ['1 va 6', '2 va 3', '−2 va −3', '5 va 6']), 1),
      q('What is the discriminant of x² + 2x + 1?', 'Чему равен дискриминант x² + 2x + 1?', 'x² + 2x + 1 ning diskriminanti nechaga teng?', ['4', '8', '0', '−4'], 2),
      q('Does x² + 1 = 0 have real roots?', 'Есть ли у x² + 1 = 0 действительные корни?', 'x² + 1 = 0 ning haqiqiy ildizlari bormi?', o(['Yes, two', 'Yes, one', 'Infinitely many', 'No'], ['Да, два', 'Да, один', 'Бесконечно много', 'Нет'], ['Ha, ikkita', 'Ha, bitta', 'Cheksiz ko‘p', "Yo'q"]), 3),
    ],
  },
  {
    slug: 'past-simple', subject: 'english', level: 'grades_5_9',
    title: { en: 'Past Simple', ru: 'Past Simple (прошедшее простое)', uz: 'Past Simple (o‘tgan zamon)' },
    summary: { en: 'Regular and irregular verbs for things that happened and finished.', ru: 'Правильные и неправильные глаголы для завершённых действий.', uz: 'Tugagan ishlar uchun to‘g‘ri va noto‘g‘ri fe’llar.' },
    questions: [
      q('Choose the correct form: Yesterday I ___ to school.', 'Выберите верную форму: Yesterday I ___ to school.', "To‘g‘ri shaklni tanlang: Yesterday I ___ to school.", ['go', 'went', 'gone', 'going'], 1),
      q('Choose the correct form: She ___ TV last night.', 'Выберите верную форму: She ___ TV last night.', "To‘g‘ri shaklni tanlang: She ___ TV last night.", ['watch', 'watches', 'watching', 'watched'], 3),
      q('What is the past simple of "buy"?', 'Какая форма past simple у "buy"?', '"buy" ning past simple shakli qaysi?', ['buyed', 'bought', 'boughted', 'buys'], 1),
      q('Choose the correct form: They ___ not at home yesterday.', 'Выберите верную форму: They ___ not at home yesterday.', "To‘g‘ri shaklni tanlang: They ___ not at home yesterday.", ['was', 'are', 'were', 'be'], 2),
    ],
  },
  {
    slug: 'articles', subject: 'english', level: 'grades_5_9',
    title: { en: 'Articles: a, an, the', ru: 'Артикли: a, an, the', uz: 'Artikllar: a, an, the' },
    summary: { en: 'When to use a, an, the, or no article at all.', ru: 'Когда использовать a, an, the или обойтись без артикля.', uz: 'Qachon a, an, the ishlatiladi va qachon artikl kerak emas.' },
    questions: [
      q('I saw ___ elephant at the zoo.', 'I saw ___ elephant at the zoo. Выберите артикль.', 'I saw ___ elephant at the zoo. Artiklni tanlang.', o(['a', 'an', 'the', '(no article)'], ['a', 'an', 'the', '(без артикля)'], ['a', 'an', 'the', '(artiklsiz)']), 1),
      q('___ sun rises in the east.', '___ sun rises in the east. Выберите артикль.', '___ sun rises in the east. Artiklni tanlang.', o(['A', 'An', 'The', '(no article)'], ['A', 'An', 'The', '(без артикля)'], ['A', 'An', 'The', '(artiklsiz)']), 2),
      q('She is ___ engineer.', 'She is ___ engineer. Выберите артикль.', 'She is ___ engineer. Artiklni tanlang.', o(['a', 'the', '(no article)', 'an'], ['a', 'the', '(без артикля)', 'an'], ['a', 'the', '(artiklsiz)', 'an']), 3),
      q('I like ___ music.', 'I like ___ music. Выберите артикль.', 'I like ___ music. Artiklni tanlang.', o(['a', 'an', 'the', '(no article)'], ['a', 'an', 'the', '(без артикля)'], ['a', 'an', 'the', '(artiklsiz)']), 3),
    ],
  },
  {
    slug: 'present-perfect', subject: 'english', level: 'grades_10_11',
    title: { en: 'Present Perfect', ru: 'Present Perfect', uz: 'Present Perfect' },
    summary: { en: 'Past actions that matter now: have/has + past participle.', ru: 'Прошлые действия, важные сейчас: have/has + причастие II.', uz: 'Hozir ahamiyatli bo‘lgan o‘tgan ishlar: have/has + V3.' },
    questions: [
      q('Choose: I ___ never been to Paris.', 'Выберите: I ___ never been to Paris.', 'Tanlang: I ___ never been to Paris.', ['have', 'has', 'had', 'am'], 0),
      q('Choose: She ___ lived here since 2020.', 'Выберите: She ___ lived here since 2020.', 'Tanlang: She ___ lived here since 2020.', ['have', 'is', 'has', 'was'], 2),
      q('What is the past participle of "write"?', 'Какая форма причастия II у "write"?', '"write" ning V3 shakli qaysi?', ['wrote', 'writed', 'written', 'writing'], 2),
      q('Choose: Have you ___ your homework yet?', 'Выберите: Have you ___ your homework yet?', 'Tanlang: Have you ___ your homework yet?', ['do', 'did', 'doing', 'done'], 3),
    ],
  },
  {
    slug: 'newtons-laws', subject: 'physics', level: 'grades_5_9',
    title: { en: "Newton's laws of motion", ru: 'Законы Ньютона', uz: 'Nyuton qonunlari' },
    summary: { en: 'Inertia, force and acceleration, action and reaction.', ru: 'Инерция, сила и ускорение, действие и противодействие.', uz: 'Inersiya, kuch va tezlanish, ta’sir va aks ta’sir.' },
    questions: [
      q('F = m × a is Newton\'s ___ law.', 'F = m × a — это ___ закон Ньютона.', 'F = m × a — Nyutonning ___ qonuni.', o(['first', 'second', 'third', 'fourth'], ['первый', 'второй', 'третий', 'четвёртый'], ['birinchi', 'ikkinchi', 'uchinchi', "to'rtinchi"]), 1),
      q('A 2 kg object accelerates at 3 m/s². What is the net force?', 'Тело массой 2 кг движется с ускорением 3 м/с². Чему равна равнодействующая сила?', '2 kg massali jism 3 m/s² tezlanish bilan harakatlanmoqda. Teng ta’sir etuvchi kuch qancha?', ['5 N', '6 N', '1.5 N', '9 N'], 1),
      q('"Every action has an equal and opposite reaction" is the ___ law.', '«Действию всегда есть равное и противоположное противодействие» — это ___ закон.', '"Har bir ta’sirga teng va qarama-qarshi aks ta’sir bor" — ___ qonun.', o(['first', 'second', 'third', 'fourth'], ['первый', 'второй', 'третий', 'четвёртый'], ['birinchi', 'ikkinchi', 'uchinchi', "to'rtinchi"]), 2),
      q('Why do passengers lurch forward when a bus brakes suddenly?', 'Почему пассажиры наклоняются вперёд при резком торможении автобуса?', 'Avtobus keskin tormozlaganda yo‘lovchilar nega oldinga og‘adi?', o(['Gravity', 'Friction with air', 'Inertia', 'Magnetism'], ['Гравитация', 'Трение о воздух', 'Инерция', 'Магнетизм'], ["Og'irlik kuchi", 'Havo ishqalanishi', 'Inersiya', 'Magnetizm']), 2),
    ],
  },
  {
    slug: 'ohms-law', subject: 'physics', level: 'grades_10_11',
    title: { en: "Ohm's law", ru: 'Закон Ома', uz: 'Om qonuni' },
    summary: { en: 'Voltage, current and resistance: V = I × R.', ru: 'Напряжение, сила тока и сопротивление: U = I × R.', uz: 'Kuchlanish, tok kuchi va qarshilik: U = I × R.' },
    questions: [
      q('Voltage 12 V, resistance 4 Ω. What is the current?', 'Напряжение 12 В, сопротивление 4 Ом. Чему равна сила тока?', 'Kuchlanish 12 V, qarshilik 4 Ω. Tok kuchi qancha?', ['3 A', '48 A', '8 A', '0.33 A'], 0),
      q('Current 2 A, resistance 5 Ω. What is the voltage?', 'Сила тока 2 А, сопротивление 5 Ом. Чему равно напряжение?', 'Tok kuchi 2 A, qarshilik 5 Ω. Kuchlanish qancha?', ['7 V', '2.5 V', '10 V', '3 V'], 2),
      q('V = 9 V, I = 3 A. What is the resistance?', 'U = 9 В, I = 3 А. Чему равно сопротивление?', 'U = 9 V, I = 3 A. Qarshilik qancha?', ['27 Ω', '3 Ω', '6 Ω', '12 Ω'], 1),
      q('Resistance doubles, voltage stays the same. The current ...', 'Сопротивление вырастает вдвое, напряжение то же. Сила тока ...', 'Qarshilik 2 marta oshdi, kuchlanish o‘zgarmadi. Tok kuchi ...', o(['doubles', 'stays the same', 'quadruples', 'halves'], ['вырастет вдвое', 'не изменится', 'вырастет вчетверо', 'уменьшится вдвое'], ['2 marta oshadi', "o'zgarmaydi", '4 marta oshadi', '2 marta kamayadi']), 3),
    ],
  },
  {
    slug: 'photosynthesis', subject: 'biology', level: 'grades_5_9',
    title: { en: 'Photosynthesis', ru: 'Фотосинтез', uz: 'Fotosintez' },
    summary: { en: 'How plants turn light, water and carbon dioxide into food and oxygen.', ru: 'Как растения превращают свет, воду и углекислый газ в питание и кислород.', uz: 'O‘simliklar yorug‘lik, suv va karbonat angidriddan qanday oziq va kislorod hosil qiladi.' },
    questions: [
      q('Which gas do plants take in for photosynthesis?', 'Какой газ растения поглощают при фотосинтезе?', 'Fotosintez uchun o‘simliklar qaysi gazni yutadi?', o(['Carbon dioxide', 'Oxygen', 'Nitrogen', 'Hydrogen'], ['Углекислый газ', 'Кислород', 'Азот', 'Водород'], ['Karbonat angidrid', 'Kislorod', 'Azot', 'Vodorod']), 0),
      q('Which gas do plants release during photosynthesis?', 'Какой газ растения выделяют при фотосинтезе?', 'Fotosintezda o‘simliklar qaysi gazni chiqaradi?', o(['Carbon dioxide', 'Oxygen', 'Methane', 'Helium'], ['Углекислый газ', 'Кислород', 'Метан', 'Гелий'], ['Karbonat angidrid', 'Kislorod', 'Metan', 'Geliy']), 1),
      q('Which pigment captures light energy?', 'Какой пигмент улавливает световую энергию?', 'Qaysi pigment yorug‘lik energiyasini yutadi?', o(['Hemoglobin', 'Keratin', 'Chlorophyll', 'Insulin'], ['Гемоглобин', 'Кератин', 'Хлорофилл', 'Инсулин'], ['Gemoglobin', 'Keratin', 'Xlorofill', 'Insulin']), 2),
      q('Where in the plant cell does photosynthesis happen?', 'В какой части растительной клетки происходит фотосинтез?', 'Fotosintez o‘simlik hujayrasining qaysi qismida bo‘ladi?', o(['Nucleus', 'Mitochondrion', 'Ribosome', 'Chloroplast'], ['Ядро', 'Митохондрия', 'Рибосома', 'Хлоропласт'], ['Yadro', 'Mitoxondriya', 'Ribosoma', 'Xloroplast']), 3),
    ],
  },
  {
    slug: 'periodic-table', subject: 'chemistry', level: 'grades_5_9',
    title: { en: 'The periodic table', ru: 'Периодическая таблица', uz: 'Davriy jadval' },
    summary: { en: 'Symbols, atomic number, noble gases and simple formulas.', ru: 'Символы, атомный номер, благородные газы и простые формулы.', uz: 'Belgilar, atom raqami, inert gazlar va oddiy formulalar.' },
    questions: [
      q('What is the chemical symbol for sodium?', 'Какой химический символ у натрия?', 'Natriyning kimyoviy belgisi qaysi?', ['Na', 'So', 'S', 'N'], 0),
      q('The atomic number equals the number of ...', 'Атомный номер равен числу ...', 'Atom raqami ... soniga teng.', o(['neutrons', 'protons', 'electron shells', 'molecules'], ['нейтронов', 'протонов', 'электронных оболочек', 'молекул'], ['neytronlar', 'protonlar', 'elektron qobiqlar', 'molekulalar']), 1),
      q('Which of these is a noble gas?', 'Какой из этих газов благородный?', 'Bulardan qaysi biri inert gaz?', o(['Oxygen', 'Chlorine', 'Neon', 'Sodium'], ['Кислород', 'Хлор', 'Неон', 'Натрий'], ['Kislorod', 'Xlor', 'Neon', 'Natriy']), 2),
      q('What is the chemical formula of water?', 'Какова химическая формула воды?', 'Suvning kimyoviy formulasi qaysi?', ['H₂O₂', 'HO₂', 'OH', 'H₂O'], 3),
    ],
  },
];

// Picked videos. Each id was checked on 2026-10-18: the video exists, is public and allows embedding (YouTube oEmbed answered 200),
// and the channel below is the one YouTube reports. Titles follow the original. Nothing here was watched end to end, so a teacher or
// admin should still look at them; people can also vote them up or down.
export interface SeedVideo { topic: string; id: string; lang: 'uz' | 'ru' | 'en'; title: string; author: string }
export const SEED_VIDEOS: SeedVideo[] = [
  { topic: 'fractions', id: 'eflK6Px6-pk', lang: 'uz', title: 'Umumiy maxrajlarni topish', author: 'Khan Academy Uzbek' },
  { topic: 'fractions', id: 'oV9Aq3CDC4s', lang: 'uz', title: 'Kasrlarni taqqoslash (har xil surat va maxrajli kasrlar)', author: 'Khan Academy Uzbek' },
  { topic: 'fractions', id: 'zkJ1gOrYhEg', lang: 'en', title: 'Adding fractions with unlike denominators', author: 'Khan Academy' },
  { topic: 'fractions', id: 'TQ0FTW1xa3k', lang: 'ru', title: 'Сложение и вычитание дробей с разными знаменателями. 5 класс', author: 'Matematik Repetitor' },
  { topic: 'percentages', id: 'EmVcWw3Ixng', lang: 'uz', title: 'Foizni topish', author: 'Khan Academy Uzbek' },
  { topic: 'percentages', id: 'qMIlsipcEn0', lang: 'uz', title: 'Foiz miqdori va asosni topish', author: 'Khan Academy Uzbek' },
  { topic: 'percentages', id: 'WYWPuG-8U5Q', lang: 'en', title: 'Percentages Made Easy!', author: 'The Organic Chemistry Tutor' },
  { topic: 'linear-equations', id: '4P3jT-Nynus', lang: 'uz', title: '1-darajali chiziqli tenglamalar. 7-sinf algebra', author: 'Maths intellekt82' },
  { topic: 'linear-equations', id: 'tuVd355R-OQ', lang: 'en', title: 'Example: two-step equations', author: 'Khan Academy' },
  { topic: 'linear-equations', id: 'LzYJVsvqS50', lang: 'en', title: 'Understanding steps when solving equations', author: 'Khan Academy' },
  { topic: 'quadratic-equations', id: 'kxArjMizIwI', lang: 'uz', title: 'Kvadrat tenglama ildizlari formulasi', author: 'Khan Academy Uzbek' },
  { topic: 'quadratic-equations', id: 'Q2bVbZ1RcAg', lang: 'ru', title: 'Решение квадратных уравнений через дискриминант. Алгебра 8 класс', author: 'MATH online' },
  { topic: 'quadratic-equations', id: 'IlNAJl36-10', lang: 'en', title: 'How To Solve Quadratic Equations Using The Quadratic Formula', author: 'The Organic Chemistry Tutor' },
  { topic: 'quadratic-equations', id: '-KWsS2FZVTA', lang: 'en', title: 'How To Solve Simple Quadratic Equations', author: 'The Organic Chemistry Tutor' },
  { topic: 'past-simple', id: 'kgcd4gj9zNw', lang: 'en', title: 'Past Simple: an easy English grammar lesson', author: 'English Panda' },
  { topic: 'past-simple', id: 'dmJrYbDjxQY', lang: 'en', title: 'Learn English Tenses: Past Simple', author: 'Learn English with Rebecca (engVid)' },
  { topic: 'articles', id: '4ZufR8iYL7w', lang: 'en', title: 'Articles in English: 5 levels of difficulty', author: 'Oxford Online English' },
  { topic: 'articles', id: '7e_LvSrRp4g', lang: 'en', title: 'A, An, The: English articles finally explained (with practice)', author: 'Mastering English with TUTOROU' },
  { topic: 'present-perfect', id: '54Xj_PcwlIY', lang: 'uz', title: 'Present Perfect (16-dars)', author: 'IBRAT FARZANDLARI' },
  { topic: 'present-perfect', id: 'XySNOXSiBMo', lang: 'en', title: 'Learn English Tenses: The Present Perfect', author: 'Learn English with Bob the Canadian' },
  { topic: 'present-perfect', id: 'mwB06pgV4Nw', lang: 'en', title: 'The Present Perfect Tense', author: 'Learn English with Jessica' },
  { topic: 'newtons-laws', id: 'BkUyufANeo4', lang: 'uz', title: 'Nyutonning ikkinchi qonuni', author: 'Khan Academy Uzbek' },
  { topic: 'newtons-laws', id: '_sSdSI3PqWo', lang: 'uz', title: 'Nyutonning uchinchi qonuni', author: 'Khan Academy Uzbek' },
  { topic: 'newtons-laws', id: 'g550H4e5FCY', lang: 'en', title: "Newton's Law of Motion: first, second and third", author: 'The Organic Chemistry Tutor' },
  { topic: 'ohms-law', id: 'ob4F2SiSWa8', lang: 'uz', title: 'Om qonuni', author: 'Khan Academy Uzbek' },
  { topic: 'ohms-law', id: 'HsLLq6Rm5tU', lang: 'en', title: 'Ohm\'s Law explained: the basics of circuit theory', author: 'The Engineering Mindset' },
  { topic: 'ohms-law', id: 'NqV6Get9FZA', lang: 'en', title: "Voltage, current and resistance: Ohm's Law", author: 'The Organic Chemistry Tutor' },
  { topic: 'photosynthesis', id: 'CMiPYHNNg28', lang: 'en', title: 'Photosynthesis (updated)', author: 'Amoeba Sisters' },
  { topic: 'photosynthesis', id: 'PSGKRd7Bbl0', lang: 'en', title: 'Photosynthesis: life processes', author: 'Khan Academy India' },
  { topic: 'periodic-table', id: '0RRVV4Diomg', lang: 'en', title: 'The Periodic Table: Crash Course Chemistry #4', author: 'CrashCourse' },
  { topic: 'periodic-table', id: 'O-48znAg7VE', lang: 'en', title: 'Solving the puzzle of the periodic table', author: 'TED-Ed' },
];
