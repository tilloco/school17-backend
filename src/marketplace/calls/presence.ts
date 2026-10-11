import { Interval } from '../common/time';
import { marketConfig } from '../common/config';

export interface SessionLike {
  joinedAt: Date;
  lastSeenAt: Date;
  leftAt: Date | null;
}

/**
 * Sessiya oralig'i: leftAt bo'lsa shu vaqtgacha; bo'lmasa va oxirgi signal eskirgan bo'lsa lastSeenAt gacha
 * (ilova yopilgan/uzilgan deb hisoblanadi); aks holda "hozir"gacha (hali ulangan).
 */
export function sessionInterval(s: SessionLike, now: Date, staleMs = marketConfig().presenceStaleSeconds * 1000): Interval {
  let end: Date;
  if (s.leftAt) end = s.leftAt;
  else if (now.getTime() - s.lastSeenAt.getTime() > staleMs) end = s.lastSeenAt;
  else end = now;
  if (end < s.joinedAt) end = s.joinedAt;
  return { start: s.joinedAt, end };
}

export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) {
      if (i.end > last.end) last.end = i.end;
    } else out.push({ start: i.start, end: i.end });
  }
  return out;
}

export function clipIntervals(list: Interval[], win: Interval): Interval[] {
  const out: Interval[] = [];
  for (const i of list) {
    const s = i.start < win.start ? win.start : i.start;
    const e = i.end > win.end ? win.end : i.end;
    if (s < e) out.push({ start: s, end: e });
  }
  return out;
}

export const totalSeconds = (list: Interval[]): number => Math.floor(list.reduce((n, i) => n + (i.end.getTime() - i.start.getTime()), 0) / 1000);

/** Ikki tomon BIR VAQTDA bo'lgan umumiy soniyalar (ikkala ro'yxat avval birlashtirilgan bo'lishi kerak). */
export function overlapSeconds(a: Interval[], b: Interval[]): number {
  let ms = 0;
  for (const x of a) {
    for (const y of b) {
      const s = Math.max(x.start.getTime(), y.start.getTime());
      const e = Math.min(x.end.getTime(), y.end.getTime());
      if (e > s) ms += e - s;
    }
  }
  return Math.floor(ms / 1000);
}

export type OutcomeKind = 'PENDING' | 'COMPLETED' | 'NO_SHOW_STUDENT' | 'NO_SHOW_TEACHER' | 'FAILED';

export interface Outcome {
  kind: OutcomeKind;
  /** To'lanadigan soniyalar: ikki tomon birga bo'lgan vaqt, rejadagi davomiylikdan oshmaydi */
  billableSeconds: number;
  note: string;
  teacherSeconds: number;
  studentSeconds: number;
  overlapSeconds: number;
}

export interface OutcomeInput {
  teacher: SessionLike[];
  student: SessionLike[];
  startAt: Date;
  endAt: Date;
  opensAt: Date;
  closesAt: Date;
  now: Date;
}

/**
 * Dars natijasini presence'dan hisoblaydi.
 * Dars hali tugamagan yoki kimdir hanuz ulangan bo'lsa (va oyna yopilmagan) => PENDING.
 */
export function decideOutcome(i: OutcomeInput): Outcome {
  const cfg = marketConfig();
  const staleMs = cfg.presenceStaleSeconds * 1000;
  const win = { start: i.opensAt, end: i.closesAt };
  const t = mergeIntervals(clipIntervals(i.teacher.map((s) => sessionInterval(s, i.now, staleMs)), win));
  const s = mergeIntervals(clipIntervals(i.student.map((x) => sessionInterval(x, i.now, staleMs)), win));
  const teacherSeconds = totalSeconds(t);
  const studentSeconds = totalSeconds(s);
  const overlap = overlapSeconds(t, s);
  const base = { teacherSeconds, studentSeconds, overlapSeconds: overlap };

  const stillConnected = [...i.teacher, ...i.student].some((x) => !x.leftAt && i.now.getTime() - x.lastSeenAt.getTime() <= staleMs);
  if (i.now < i.endAt) return { kind: 'PENDING', billableSeconds: 0, note: 'lesson_not_over', ...base };
  if (i.now < i.closesAt && stillConnected) return { kind: 'PENDING', billableSeconds: 0, note: 'still_connected', ...base };

  const scheduled = Math.floor((i.endAt.getTime() - i.startAt.getTime()) / 1000);
  if (overlap >= cfg.minLessonSeconds) {
    return { kind: 'COMPLETED', billableSeconds: Math.min(overlap, scheduled), note: 'ok', ...base };
  }
  const teacherPresent = teacherSeconds >= cfg.presentMinSeconds;
  const studentPresent = studentSeconds >= cfg.presentMinSeconds;
  if (teacherPresent && studentPresent) return { kind: 'FAILED', billableSeconds: 0, note: 'insufficient_overlap', ...base };
  if (teacherPresent) return { kind: 'NO_SHOW_STUDENT', billableSeconds: 0, note: 'student_absent', ...base };
  if (studentPresent) return { kind: 'NO_SHOW_TEACHER', billableSeconds: 0, note: 'teacher_absent', ...base };
  return { kind: 'FAILED', billableSeconds: 0, note: 'nobody_joined', ...base };
}

export interface RecordingPolicyInput {
  anyMinor: boolean;
  teacherConsent: boolean | null;
  studentConsent: boolean | null;
}

/** Yozib olish: standart O'CHIQ; voyaga yetmagan ishtirokchi bo'lsa HECH QACHON; ikkala tomonning aniq roziligi shart. NEEDS LAWYER. */
export function recordingAllowed(i: RecordingPolicyInput): { allowed: boolean; reason: string } {
  if (i.anyMinor) return { allowed: false, reason: 'minor_participant' };
  if (i.teacherConsent !== true || i.studentConsent !== true) return { allowed: false, reason: 'consent_missing' };
  return { allowed: true, reason: 'ok' };
}
