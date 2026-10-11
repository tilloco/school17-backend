// Fan, daraja va til katalogi. Mijoz nomlarni o'z tilida ko'rsatadi (i18n kalitlari: subject.<id>, level.<id>).
export const SUBJECTS = [
  'math', 'physics', 'chemistry', 'biology', 'english', 'russian', 'uzbek', 'history',
  'geography', 'informatics', 'law', 'economics', 'literature', 'exam_prep', 'music', 'art',
] as const;
export const LEVELS = ['primary', 'grades_5_9', 'grades_10_11', 'university', 'adult', 'exam_prep'] as const;
export const LANGUAGES = ['uz', 'ru', 'en'] as const;

export type SubjectId = (typeof SUBJECTS)[number];
export type LevelId = (typeof LEVELS)[number];
export type LanguageId = (typeof LANGUAGES)[number];

export const isSubject = (s: string): s is SubjectId => (SUBJECTS as readonly string[]).includes(s);
export const isLevel = (s: string): s is LevelId => (LEVELS as readonly string[]).includes(s);
export const isLanguage = (s: string): s is LanguageId => (LANGUAGES as readonly string[]).includes(s);
