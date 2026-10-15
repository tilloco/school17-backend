import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ClassFeedPost, ClassSession, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor } from '../common/actor';
import { AuditService } from '../common/audit.service';
import { ClockService } from '../common/clock';
import { GuardianService } from '../guardian/guardian.service';
import { NotificationsService } from '../notifications/notifications.service';
import { detectContactInfo } from '../safety/contact-info';
import { ADULT_AGE, ageInYears } from '../common/actor';
import { firstName } from './class-rules';
import { ModuleRef } from '@nestjs/core';

const NOTE_EDIT_MS = 24 * 3_600_000; // dars yozuvi 24 soat tahrirlanadi (C3)
const MAX = { topic: 200, homework: 1000, next: 500, hwTitle: 200, hwText: 4000, submission: 4000, comment: 1000, answer: 1500 };

export interface RecapData {
  startedAt: string | null;
  endedAt: string | null;
  durationSec: number;
  endReason: string | null;
  attendance: { pupilId: string; name: string; attended: boolean; totalSeconds: number; joinedLate: boolean; joinCount: number }[];
  questions: { asked: number; answered: number; unanswered: { id: string; text: string }[]; answeredList: { id: string; text: string; reply: string | null }[] };
  files: { id: string; name: string }[];
  polls: unknown[];
}

@Injectable()
export class ClassFeedService {
  constructor(private prisma: PrismaService, private clock: ClockService, private audit: AuditService, private guardians: GuardianService, private notifications: NotificationsService, private moduleRef: ModuleRef) {}

  // ---------- ruxsat ----------
  private async cls(actor: Actor, classId: string) {
    const c = await this.prisma.class.findUnique({ where: { id: classId }, include: { teacher: { select: { userId: true } } } });
    if (!c) throw new NotFoundException('Class not found');
    if (c.teacher.userId === actor.id) return { c, teacher: true, seats: [] as string[] };
    const all = actor.role === Role.GUARDIAN ? await this.guardians.linkedStudentIds(actor.id) : actor.role === Role.STUDENT ? [actor.id] : [];
    const enrolled = all.length ? await this.prisma.classEnrollment.findMany({ where: { classId, pupilId: { in: all }, status: 'ACTIVE' }, select: { pupilId: true } }) : [];
    if (!enrolled.length) throw new NotFoundException('Class not found');
    return { c, teacher: false, seats: enrolled.map((e) => e.pupilId) };
  }
  private async teacherCls(actor: Actor, classId: string) {
    const r = await this.cls(actor, classId);
    if (!r.teacher) throw new ForbiddenException('Teacher only');
    return r.c;
  }
  private async sessionCtx(actor: Actor, sessionId: string) {
    const s = await this.prisma.classSession.findUnique({ where: { id: sessionId } });
    if (!s) throw new NotFoundException('Session not found');
    return { s, ...(await this.cls(actor, s.classId)) };
  }
  async noContact(classId: string, text: string) {
    if (!detectContactInfo(text).found) return;
    const pupils = await this.prisma.classEnrollment.findMany({ where: { classId, status: 'ACTIVE' }, select: { pupil: { select: { dateOfBirth: true } } } });
    const now = this.clock.now();
    if (pupils.some((p) => !p.pupil.dateOfBirth || ageInYears(p.pupil.dateOfBirth, now) < ADULT_AGE)) throw new BadRequestException({ message: "For safety, contact details can't be shared in a class with pupils under 18", code: 'CONTACT_INFO_NOT_ALLOWED' });
  }

  // ---------- recap ----------
  /** Sessiya tugaganda chaqiriladi (o'qituvchi kelmagan sessiyalar uchun emas). Idempotent. */
  async buildRecap(sessionId: string): Promise<void> {
    const s = await this.prisma.classSession.findUnique({ where: { id: sessionId }, include: { class: { include: { teacher: { select: { userId: true } } } } } });
    if (!s || s.status !== 'ENDED' || s.teacherNoShow) return;
    if (await this.prisma.classSessionRecap.findUnique({ where: { sessionId } })) return;
    const [enr, att, qs, files] = await Promise.all([
      this.prisma.classEnrollment.findMany({ where: { classId: s.classId, status: 'ACTIVE' }, include: { pupil: { select: { id: true, name: true } } } }),
      this.prisma.classAttendance.findMany({ where: { sessionId } }),
      this.prisma.classQuestion.findMany({ where: { sessionId, status: { not: 'HIDDEN' } }, orderBy: { seq: 'asc' }, take: 300 }),
      this.prisma.classFile.findMany({ where: { id: { in: s.presentedFileIds } }, select: { id: true, name: true } }),
    ]);
    const answered = qs.filter((q) => q.status === 'ANSWERED');
    const data: RecapData = {
      startedAt: s.startedAt?.toISOString() ?? null,
      endedAt: s.endedAt?.toISOString() ?? null,
      durationSec: s.startedAt && s.endedAt ? Math.max(0, Math.round((s.endedAt.getTime() - s.startedAt.getTime()) / 1000)) : 0,
      endReason: s.endReason,
      attendance: enr.map((e) => {
        const a = att.find((x) => x.pupilId === e.pupilId);
        return { pupilId: e.pupilId, name: e.pupil.name ?? '', attended: !!a, totalSeconds: a?.totalSeconds ?? 0, joinedLate: a?.joinedLate ?? false, joinCount: a?.joinCount ?? 0 };
      }),
      questions: {
        asked: qs.length,
        answered: answered.length,
        unanswered: qs.filter((q) => q.status !== 'ANSWERED').map((q) => ({ id: q.id, text: q.text })),
        answeredList: answered.map((q) => ({ id: q.id, text: q.text, reply: q.replyText })),
      },
      files,
      polls: await this.pollSummary(sessionId),
    };
    await this.prisma.classSessionRecap.create({ data: { sessionId, data: data as any, createdAt: this.clock.now() } });
    try {
      await this.prisma.classFeedPost.create({ data: { classId: s.classId, sessionId, kind: 'RECAP', authorId: s.class.teacher.userId, noteKey: `RECAP:${sessionId}`, createdAt: this.clock.now() } });
    } catch (e: any) {
      if (e?.code !== 'P2002') throw e;
    }
  }

  /** ClassPollService ModuleRef orqali olinadi (ClassPollService ClassFeedService'ga bog'liq: doiraviy bog'lanishdan qochish) */
  private async pollSummary(sessionId: string): Promise<unknown[]> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ClassPollService } = require('./class-poll.service');
    return this.moduleRef.get(ClassPollService, { strict: false }).closeAllAndSummarize(sessionId);
  }

  async recap(actor: Actor, sessionId: string) {
    const { s, teacher, seats } = await this.sessionCtx(actor, sessionId);
    const r = await this.prisma.classSessionRecap.findUnique({ where: { sessionId } });
    if (!r) throw new NotFoundException('No recap for this session');
    const d = r.data as unknown as RecapData;
    const note = await this.prisma.classFeedPost.findUnique({ where: { noteKey: `NOTE:${sessionId}` } });
    const noteView = note ? { topic: (note.data as any)?.topic ?? '', homework: (note.data as any)?.homework ?? '', nextStep: (note.data as any)?.nextStep ?? '' } : null;
    if (teacher) return { role: 'teacher', sessionId, startAt: s.startAt, ...d, note: noteView };
    return {
      role: 'pupil', sessionId, startAt: s.startAt, startedAt: d.startedAt, endedAt: d.endedAt, durationSec: d.durationSec,
      // O'quvchi/vasiy: faqat o'z (bolasining) davomati, javob berilgan savollar, ko'rsatilgan fayllar nomi, yozuv. Javobsiz savollar va sinfdoshlar yo'q.
      attendance: d.attendance.filter((a) => seats.includes(a.pupilId)).map((a) => ({ pupilId: a.pupilId, attended: a.attended, totalSeconds: a.totalSeconds, joinedLate: a.joinedLate })),
      questions: { asked: d.questions.asked, answered: d.questions.answered, answeredList: d.questions.answeredList.map((q) => ({ text: q.text, reply: q.reply })) },
      files: d.files.map((f) => ({ name: f.name })),
      polls: d.polls,
      note: noteView,
    };
  }

  /** Bola(lar)ning sinfdagi davomati: o'quvchi o'zi yoki bog'langan vasiy (haftalik hisobot C6 shundan oladi) */
  async attendanceMine(actor: Actor, classId: string, take = 30) {
    const { seats } = await this.cls(actor, classId);
    if (!seats.length) throw new ForbiddenException('Pupils and guardians only');
    const sessions = await this.prisma.classSession.findMany({ where: { classId, status: 'ENDED', teacherNoShow: false }, orderBy: { startAt: 'desc' }, take: Math.min(take, 100) });
    const att = await this.prisma.classAttendance.findMany({ where: { sessionId: { in: sessions.map((s) => s.id) }, pupilId: { in: seats } } });
    const names = new Map((await this.prisma.user.findMany({ where: { id: { in: seats } }, select: { id: true, name: true } })).map((u) => [u.id, firstName(u.name)]));
    return sessions.flatMap((s) => seats.map((p) => {
      const a = att.find((x) => x.sessionId === s.id && x.pupilId === p);
      return { sessionId: s.id, startAt: s.startAt, pupil: names.get(p) ?? '', attended: !!a, totalSeconds: a?.totalSeconds ?? 0, joinedLate: a?.joinedLate ?? false };
    }));
  }

  // ---------- yozuv (C3, sinf uchun) ----------
  async putNote(actor: Actor, sessionId: string, input: { topic?: string; homework?: string; nextStep?: string }) {
    const { s, teacher } = await this.sessionCtx(actor, sessionId);
    if (!teacher) throw new ForbiddenException('Teacher only');
    if (s.status !== 'ENDED' || s.teacherNoShow) throw new ConflictException({ message: 'Notes can be written after a class that took place', code: 'NOT_ENDED' });
    const topic = (input.topic ?? '').trim();
    const homework = (input.homework ?? '').trim();
    const nextStep = (input.nextStep ?? '').trim();
    if (!topic && !homework && !nextStep) throw new BadRequestException('Write at least one field');
    if (topic.length > MAX.topic || homework.length > MAX.homework || nextStep.length > MAX.next) throw new BadRequestException('Text is too long');
    await this.noContact(s.classId, `${topic} ${homework} ${nextStep}`);
    const now = this.clock.now();
    const key = `NOTE:${sessionId}`;
    const existing = await this.prisma.classFeedPost.findUnique({ where: { noteKey: key } });
    if (existing) {
      if (now.getTime() - existing.createdAt.getTime() > NOTE_EDIT_MS) throw new ConflictException({ message: 'Notes can be edited for 24 hours', code: 'EDIT_WINDOW_CLOSED' });
      const u = await this.prisma.classFeedPost.update({ where: { id: existing.id }, data: { title: topic, data: { topic, homework, nextStep } as any, editedAt: now } });
      return this.postView(u);
    }
    const p = await this.prisma.classFeedPost.create({ data: { classId: s.classId, sessionId, kind: 'NOTE', authorId: actor.id, title: topic, data: { topic, homework, nextStep } as any, noteKey: key, createdAt: now } });
    await this.audit.log(actor, { action: 'class.note', targetType: 'ClassFeedPost', targetId: p.id });
    return this.postView(p);
  }

  // ---------- kech javob ----------
  async lateAnswer(actor: Actor, sessionId: string, questionId: string, textIn: string) {
    const { s, teacher } = await this.sessionCtx(actor, sessionId);
    if (!teacher) throw new ForbiddenException('Teacher only');
    const text = textIn.trim();
    if (!text || text.length > MAX.answer) throw new BadRequestException('Answer must be 1..1500 characters');
    const q = await this.prisma.classQuestion.findFirst({ where: { id: questionId, sessionId } });
    if (!q) throw new NotFoundException('Question not found');
    if (q.status === 'ANSWERED' && q.replyText) throw new ConflictException({ message: 'Already answered', code: 'ALREADY_ANSWERED' });
    await this.noContact(s.classId, text);
    const now = this.clock.now();
    await this.prisma.classQuestion.update({ where: { id: q.id }, data: { status: 'ANSWERED', replyText: text, repliedAt: now } });
    // Savol matni va javob lentaga qo'yiladi; muallif ismi hech qachon (anonim savol sirligi saqlanadi)
    const p = await this.prisma.classFeedPost.create({ data: { classId: s.classId, sessionId, kind: 'ANSWER', authorId: actor.id, title: q.text.slice(0, 200), text, data: { questionId: q.id } as any, createdAt: now } });
    await this.audit.log(actor, { action: 'class.question.late_answer', targetType: 'ClassQuestion', targetId: q.id });
    return this.postView(p);
  }

  // ---------- lenta ----------
  postView(r: ClassFeedPost) {
    return { id: r.id, kind: r.kind, sessionId: r.sessionId, title: r.title, text: r.text, data: r.kind === 'RECAP' ? null : r.data, hasImage: !!r.imageKey, at: r.createdAt, editedAt: r.editedAt };
  }
  async feed(actor: Actor, classId: string, before?: string) {
    await this.cls(actor, classId);
    const b = before ? new Date(before) : null;
    const rows = await this.prisma.classFeedPost.findMany({ where: { classId, ...(b && !isNaN(b.getTime()) ? { createdAt: { lt: b } } : {}) }, orderBy: { createdAt: 'desc' }, take: 30 });
    return rows.map((r) => this.postView(r));
  }

  // ---------- uy vazifasi (C4, sinf uchun) ----------
  async createHomework(actor: Actor, classId: string, input: { title: string; text?: string; dueAt: string }) {
    const c = await this.teacherCls(actor, classId);
    if (c.status !== 'ACTIVE') throw new ConflictException('Class is cancelled');
    const title = input.title.trim();
    const text = (input.text ?? '').trim();
    const due = new Date(input.dueAt);
    const now = this.clock.now();
    if (!title || title.length > MAX.hwTitle || text.length > MAX.hwText) throw new BadRequestException('Bad title or text');
    if (isNaN(due.getTime()) || due <= now || due.getTime() - now.getTime() > 180 * 86_400_000) throw new BadRequestException('Deadline must be in the future (within 180 days)');
    await this.noContact(classId, `${title} ${text}`);
    const hw = await this.prisma.classHomework.create({ data: { classId, title, text, dueAt: due, createdAt: now } });
    const post = await this.prisma.classFeedPost.create({ data: { classId, kind: 'HOMEWORK', authorId: actor.id, title, text, data: { homeworkId: hw.id, dueAt: due.toISOString() } as any, createdAt: now } });
    await this.prisma.classHomework.update({ where: { id: hw.id }, data: { feedPostId: post.id } });
    const pupils = await this.prisma.classEnrollment.findMany({ where: { classId, status: 'ACTIVE' }, select: { pupilId: true } });
    for (const p of pupils) for (const u of [p.pupilId, ...(await this.guardians.guardianIdsOf(p.pupilId))]) await this.notifications.enqueue(u, 'class.homework', { classId, homeworkId: hw.id }, { dedupeKey: `hw:${hw.id}:${u}` });
    await this.audit.log(actor, { action: 'class.homework.create', targetType: 'ClassHomework', targetId: hw.id });
    return { id: hw.id, title, dueAt: due, feedPostId: post.id };
  }

  async listHomework(actor: Actor, classId: string) {
    const { teacher, seats } = await this.cls(actor, classId);
    const rows = await this.prisma.classHomework.findMany({ where: { classId }, orderBy: { dueAt: 'desc' }, take: 50, include: { submissions: true } });
    const now = this.clock.now();
    return rows.map((h) => ({
      id: h.id, title: h.title, text: h.text, dueAt: h.dueAt, overdue: h.dueAt < now,
      ...(teacher ? { submitted: h.submissions.length, marked: h.submissions.filter((s) => s.markedAt).length } : { mine: h.submissions.filter((s) => seats.includes(s.pupilId)).map((s) => this.subView(s)) }),
    }));
  }

  private subView(s: { id: string; pupilId: string; text: string; fileId: string | null; submittedAt: Date; late: boolean; score: number | null; comment: string | null; markedAt: Date | null }, name?: string | null) {
    return { id: s.id, pupilId: s.pupilId, name: name ?? undefined, text: s.text, fileId: s.fileId, submittedAt: s.submittedAt, late: s.late, score: s.score, comment: s.comment, marked: !!s.markedAt };
  }

  async homework(actor: Actor, classId: string, hwId: string) {
    const { teacher, seats } = await this.cls(actor, classId);
    const h = await this.prisma.classHomework.findFirst({ where: { id: hwId, classId }, include: { submissions: true } });
    if (!h) throw new NotFoundException('Homework not found');
    const base = { id: h.id, title: h.title, text: h.text, dueAt: h.dueAt };
    if (!teacher) return { ...base, mine: h.submissions.filter((s) => seats.includes(s.pupilId)).map((s) => this.subView(s)) };
    const enr = await this.prisma.classEnrollment.findMany({ where: { classId, status: 'ACTIVE' }, include: { pupil: { select: { id: true, name: true } } } });
    return {
      ...base,
      pupils: enr.map((e) => {
        const s = h.submissions.find((x) => x.pupilId === e.pupilId);
        return { pupilId: e.pupilId, name: e.pupil.name, submission: s ? this.subView(s) : null };
      }),
    };
  }

  async submit(actor: Actor, classId: string, hwId: string, input: { text?: string; fileId?: string; studentId?: string }) {
    const { seats } = await this.cls(actor, classId);
    if (!seats.length) throw new ForbiddenException('Pupils and guardians only');
    const pupilId = actor.role === Role.GUARDIAN ? input.studentId : actor.id;
    if (!pupilId || !seats.includes(pupilId)) throw new NotFoundException('Pupil not found');
    const h = await this.prisma.classHomework.findFirst({ where: { id: hwId, classId } });
    if (!h) throw new NotFoundException('Homework not found');
    const text = (input.text ?? '').trim();
    if (text.length > MAX.submission) throw new BadRequestException('Text is too long');
    if (!text && !input.fileId) throw new BadRequestException('Send text or a file');
    let fileId: string | null = null;
    if (input.fileId) {
      const f = await this.prisma.storedFile.findFirst({ where: { id: input.fileId, ownerId: actor.id, purpose: 'HOMEWORK', status: 'READY', deletedAt: null } });
      if (!f) throw new NotFoundException('File not found');
      fileId = f.id;
    }
    if (text) await this.noContact(classId, text);
    const now = this.clock.now();
    const existing = await this.prisma.classHomeworkSubmission.findUnique({ where: { homeworkId_pupilId: { homeworkId: hwId, pupilId } } });
    if (existing?.markedAt) throw new ConflictException({ message: 'Already marked by the teacher', code: 'ALREADY_MARKED' });
    const late = now > h.dueAt;
    const s = existing
      ? await this.prisma.classHomeworkSubmission.update({ where: { id: existing.id }, data: { text, fileId, submittedAt: now, late } })
      : await this.prisma.classHomeworkSubmission.create({ data: { homeworkId: hwId, pupilId, text, fileId, submittedAt: now, late } });
    await this.audit.log(actor, { action: 'class.homework.submit', targetType: 'ClassHomework', targetId: hwId, metadata: { late } });
    return this.subView(s);
  }

  async mark(actor: Actor, classId: string, hwId: string, pupilId: string, input: { score: number; comment?: string }) {
    await this.teacherCls(actor, classId);
    if (!Number.isInteger(input.score) || input.score < 0 || input.score > 100) throw new BadRequestException('Score must be 0..100');
    const comment = (input.comment ?? '').trim();
    if (comment.length > MAX.comment) throw new BadRequestException('Comment is too long');
    const sub = await this.prisma.classHomeworkSubmission.findFirst({ where: { homeworkId: hwId, pupilId, homework: { classId } } });
    if (!sub) throw new NotFoundException('Submission not found');
    if (comment) await this.noContact(classId, comment);
    const u = await this.prisma.classHomeworkSubmission.update({ where: { id: sub.id }, data: { score: input.score, comment: comment || null, markedAt: this.clock.now() } });
    for (const uid of [pupilId, ...(await this.guardians.guardianIdsOf(pupilId))]) await this.notifications.enqueue(uid, 'class.homework_marked', { classId, homeworkId: hwId }, { dedupeKey: `hwm:${sub.id}:${uid}:${u.score}` });
    await this.audit.log(actor, { action: 'class.homework.mark', targetType: 'ClassHomework', targetId: hwId, metadata: { pupilId } });
    return this.subView(u);
  }
}
