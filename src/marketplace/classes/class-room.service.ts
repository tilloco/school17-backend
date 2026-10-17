import { BadGatewayException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ClassSession, Role, StageState } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor } from '../common/actor';
import { AuditService } from '../common/audit.service';
import { ClockService } from '../common/clock';
import { marketConfig } from '../common/config';
import { CALL_PROVIDER, CallProvider, ProviderEvent, PublishSource } from '../calls/call-provider';
import { NotificationsService } from '../notifications/notifications.service';
import { firstName } from './class-rules';
import { ClassPaymentsService } from './class-payments.service';
import { ClassFeedService } from './class-feed.service';

export const classRoomName = (sessionId: string) => `class-${sessionId}`;
const sourcesFor = (s: StageState): PublishSource[] => (s === 'VOICE' ? ['microphone'] : s === 'VOICE_VIDEO' ? ['microphone', 'camera'] : []);

@Injectable()
export class ClassRoomService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ClassRoom');
  private timer?: NodeJS.Timeout;

  constructor(
    private prisma: PrismaService,
    private clock: ClockService,
    private audit: AuditService,
    private notifications: NotificationsService,
    private payments: ClassPaymentsService,
    private feedSvc: ClassFeedService,
    @Inject(CALL_PROVIDER) private provider: CallProvider,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    // R12: navbatga o'tkaziladi. Idempotent.
    this.timer = setInterval(() => void this.sweep().catch((e) => this.log.warn(e.message)), 30_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // ---------- ruxsat ----------
  private async load(actor: Actor, sessionId: string) {
    const s = await this.prisma.classSession.findUnique({ where: { id: sessionId }, include: { class: { include: { teacher: { select: { userId: true } } } } } });
    if (!s) throw new NotFoundException('Session not found');
    if (s.class.teacher.userId === actor.id) return { s: await this.refresh(s), c: s.class, teacher: true as const };
    if (actor.role === Role.STUDENT) {
      const e = await this.prisma.classEnrollment.findFirst({ where: { classId: s.classId, pupilId: actor.id, status: 'ACTIVE' }, select: { id: true } });
      if (e) return { s: await this.refresh(s), c: s.class, teacher: false as const };
    }
    throw new NotFoundException('Session not found');
  }
  private async asTeacher(actor: Actor, sessionId: string) {
    const r = await this.load(actor, sessionId);
    if (!r.teacher) throw new ForbiddenException('Teacher only');
    return r;
  }
  private async asPupil(actor: Actor, sessionId: string) {
    const r = await this.load(actor, sessionId);
    if (r.teacher) throw new ForbiddenException('Pupils only');
    return r;
  }

  // ---------- hayot tsikli ----------
  /** Vaqtga bog'liq o'tishlar (kutish xonasi, "o'qituvchi kelmadi", uzilish, vaqt limiti). Idempotent. */
  async refresh<T extends ClassSession>(s: T): Promise<T> {
    const cfg = marketConfig();
    const now = this.clock.now();
    if (s.status === 'SCHEDULED' || s.status === 'LOBBY') {
      if (now.getTime() > s.startAt.getTime() + cfg.classTeacherNoShowMinutes * 60_000) return (await this.finish(s, 'teacher_no_show', true)) as T;
      if (s.status === 'SCHEDULED' && now.getTime() >= s.startAt.getTime() - cfg.classLobbyMinutes * 60_000) {
        const r = await this.prisma.classSession.updateMany({ where: { id: s.id, status: 'SCHEDULED' }, data: { status: 'LOBBY' } });
        if (r.count) return { ...s, status: 'LOBBY' };
      }
    } else if (s.status === 'LIVE') {
      if (s.teacherAbsentSince && now.getTime() - s.teacherAbsentSince.getTime() > cfg.classTeacherDropSeconds * 1000) return (await this.finish(s, 'teacher_dropped', true)) as T;
      if (now.getTime() > s.endAt.getTime() + cfg.classOverrunMinutes * 60_000) return (await this.finish(s, 'time_limit', false)) as T;
    }
    return s;
  }

  private async finish(s: ClassSession, reason: string, teacherNoShow: boolean): Promise<ClassSession> {
    const now = this.clock.now();
    const was = s.status;
    const r = await this.prisma.classSession.updateMany({ where: { id: s.id, status: { in: ['SCHEDULED', 'LOBBY', 'LIVE'] } }, data: { status: 'ENDED', endedAt: now, endReason: reason, teacherNoShow } });
    const fresh = await this.prisma.classSession.findUniqueOrThrow({ where: { id: s.id } });
    if (!r.count) return fresh;
    await this.closePresences(s.id, now);
    await this.feedSvc.buildRecap(s.id).catch((e) => this.log.warn(`recap: ${e.message}`));
    await this.prisma.classParticipant.updateMany({ where: { sessionId: s.id }, data: { stage: 'NONE', handRaisedAt: null } });
    if (was === 'LIVE') await this.provider.closeRoom(classRoomName(s.id)).catch((e) => this.log.warn(`closeRoom: ${e.message}`));
    if (teacherNoShow) await this.payments.waiveSession(s.id).catch((e) => this.log.warn(`waive: ${e.message}`));
    if (teacherNoShow) await this.notifyPupils(s.classId, (uid) => this.notifications.enqueue(uid, 'class.teacher_noshow', { classId: s.classId, sessionId: s.id }, { dedupeKey: `noshow:${s.id}` }));
    return fresh;
  }

  private async closePresences(sessionId: string, at: Date) {
    const open = await this.prisma.classAttendance.findMany({ where: { sessionId, presentNow: true } });
    for (const a of open) {
      const add = a.lastJoinAt ? Math.max(0, Math.round((at.getTime() - a.lastJoinAt.getTime()) / 1000)) : 0;
      await this.prisma.classAttendance.update({ where: { id: a.id }, data: { presentNow: false, lastLeftAt: at, totalSeconds: a.totalSeconds + add } });
    }
  }

  async sweep(): Promise<number> {
    const now = this.clock.now();
    const rows = await this.prisma.classSession.findMany({ where: { status: { in: ['SCHEDULED', 'LOBBY', 'LIVE'] }, startAt: { lt: new Date(now.getTime() + marketConfig().classLobbyMinutes * 60_000 + 1) } }, take: 500 });
    let changed = 0;
    for (const s of rows) if ((await this.refresh(s)).status !== s.status) changed++;
    return changed;
  }

  async start(actor: Actor, sessionId: string) {
    const { s, c } = await this.asTeacher(actor, sessionId);
    if (s.status === 'LIVE') return this.state(actor, sessionId);
    if (s.status === 'ENDED' || s.status === 'CANCELLED') throw new ConflictException({ message: 'Session is over', code: 'SESSION_OVER' });
    if (s.status !== 'LOBBY') throw new ConflictException({ message: 'Too early: the lobby opens shortly before the class', code: 'TOO_EARLY' });
    await this.provider.ensureClassRoom(classRoomName(s.id), marketConfig().classMaxPupils + 1);
    const r = await this.prisma.classSession.updateMany({ where: { id: s.id, status: 'LOBBY' }, data: { status: 'LIVE', startedAt: this.clock.now(), teacherAbsentSince: null } });
    if (r.count) {
      await this.notifyPupils(c.id, (uid) => this.notifications.enqueue(uid, 'class.live', { classId: c.id, sessionId: s.id }, { dedupeKey: `live:${s.id}` }));
      await this.audit.log(actor, { action: 'class.session.start', targetType: 'ClassSession', targetId: s.id });
    }
    return this.state(actor, sessionId);
  }

  async end(actor: Actor, sessionId: string) {
    const { s } = await this.asTeacher(actor, sessionId);
    if (s.status === 'LIVE') {
      await this.finish(s, 'teacher_ended', false);
      await this.audit.log(actor, { action: 'class.session.end', targetType: 'ClassSession', targetId: s.id });
    } else if (s.status !== 'ENDED') throw new ConflictException({ message: 'Session is not live', code: 'NOT_LIVE' });
    return this.state(actor, sessionId);
  }

  // ---------- token ----------
  async token(actor: Actor, sessionId: string) {
    const { s, teacher } = await this.load(actor, sessionId);
    if (s.status !== 'LIVE') throw new ConflictException({ message: 'The class is not live', code: 'NOT_LIVE', status: s.status });
    const cfg = marketConfig();
    let sources: PublishSource[] = [];
    if (!teacher) {
      const p = await this.prisma.classParticipant.findUnique({ where: { sessionId_pupilId: { sessionId, pupilId: actor.id } } });
      if (p?.removedAt) throw new ForbiddenException({ message: 'You were removed from this session', code: 'REMOVED_FROM_SESSION' });
      if (s.locked) throw new ForbiddenException({ message: 'The room is locked', code: 'ROOM_LOCKED' });
      const gate = await this.payments.gate(s.classId, actor.id, s);
      if (gate.required && !gate.ok) throw new ForbiddenException({ message: 'Payment is marked as not done for this period. Pay the teacher directly and ask the teacher to confirm, or ask for a one-time pass.', code: 'PAYMENT_REQUIRED', gate });
      sources = sourcesFor(p?.stage ?? 'NONE');
    }
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { name: true } });
    const t = await this.provider.mintClassToken({
      roomName: classRoomName(sessionId), identity: actor.id, displayName: firstName(u.name), ttlSeconds: cfg.classTokenTtlSeconds, now: this.clock.now(), isTeacher: teacher, publishSources: sources,
    });
    return { token: t.token, url: t.url, expiresAt: t.expiresAt, role: teacher ? 'teacher' : 'pupil', roomName: classRoomName(sessionId) };
  }

  // ---------- holat ----------
  async state(actor: Actor, sessionId: string) {
    const { s, teacher } = await this.load(actor, sessionId);
    const cfg = marketConfig();
    const stageCount = await this.prisma.classParticipant.count({ where: { sessionId, stage: { not: 'NONE' }, removedAt: null } });
    const me = teacher ? null : await this.prisma.classParticipant.findUnique({ where: { sessionId_pupilId: { sessionId, pupilId: actor.id } } });
    return {
      id: s.id, classId: s.classId, protectContent: !!(await this.prisma.class.findUnique({ where: { id: s.classId }, select: { protectContent: true } }))?.protectContent, role: teacher ? 'teacher' : 'pupil', status: s.status, startAt: s.startAt, endAt: s.endAt,
      lobbyOpensAt: new Date(s.startAt.getTime() - cfg.classLobbyMinutes * 60_000),
      stageMode: s.stageMode, chatMode: s.chatMode, questionsMode: s.questionsMode, slowModeSeconds: s.slowModeSeconds, handRaiseOn: s.handRaiseOn, locked: s.locked, spotlightPupilId: s.spotlightPupilId,
      teacherReconnecting: s.status === 'LIVE' && !!s.teacherAbsentSince, teacherNoShow: s.teacherNoShow, endReason: s.endReason,
      presentation: await this.presentation(s),
      whiteboardRev: s.whiteboardRev,
      stageCount, stageMax: cfg.classMaxStagePupils,
      me: teacher ? null : { handRaised: !!me?.handRaisedAt, stage: me?.stage ?? 'NONE', removed: !!me?.removedAt, paymentGate: await this.payments.gate(s.classId, actor.id, s) },
    };
  }

  private async presentation(s: ClassSession) {
    if (!s.presentFileId) return null;
    const f = await this.prisma.classFile.findFirst({ where: { id: s.presentFileId, deletedAt: null, takedownAt: null } });
    return f ? { fileId: f.id, name: f.name, page: s.presentPage, pageCount: f.pageCount, renderedPages: f.renderedPages, renderStatus: f.renderStatus } : null;
  }

  // ---------- qo'l ko'tarish va sahna ----------
  private async liveParticipant(actor: Actor, sessionId: string) {
    const { s } = await this.asPupil(actor, sessionId);
    if (s.status !== 'LIVE') throw new ConflictException({ message: 'The class is not live', code: 'NOT_LIVE' });
    const p = await this.prisma.classParticipant.findUnique({ where: { sessionId_pupilId: { sessionId, pupilId: actor.id } } });
    if (p?.removedAt) throw new ForbiddenException({ message: 'You were removed from this session', code: 'REMOVED_FROM_SESSION' });
    return { s, p };
  }

  async hand(actor: Actor, sessionId: string, raised: boolean) {
    const { s, p } = await this.liveParticipant(actor, sessionId);
    if (s.stageMode !== 'HAND_RAISE' || !s.handRaiseOn) throw new ConflictException({ message: 'Raising hands is off', code: 'HAND_RAISE_OFF' });
    if (raised && p?.stage && p.stage !== 'NONE') throw new ConflictException({ message: 'You are already on stage', code: 'ALREADY_ON_STAGE' });
    await this.prisma.classParticipant.upsert({
      where: { sessionId_pupilId: { sessionId, pupilId: actor.id } },
      update: { handRaisedAt: raised ? (p?.handRaisedAt ?? this.clock.now()) : null },
      create: { sessionId, pupilId: actor.id, handRaisedAt: raised ? this.clock.now() : null },
    });
    await this.provider.setParticipantAttributes(classRoomName(sessionId), actor.id, { hand: raised ? '1' : '0' }).catch((e) => this.log.warn(`attr: ${e.message}`));
    return { handRaised: raised };
  }

  /** Atomik: sessiya qatori qulflanadi, sahna to'lganini shu qulf ostida tekshiramiz (parallel so'rovlarda ham CLASS_MAX_STAGE_PUPILS dan oshmaydi). */
  private async setStage(sessionId: string, pupilId: string, mode: StageState) {
    const max = marketConfig().classMaxStagePupils;
    const prev = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ClassSession" WHERE id = ${sessionId} FOR UPDATE`;
      const cur = await tx.classParticipant.findUnique({ where: { sessionId_pupilId: { sessionId, pupilId } } });
      if (cur?.removedAt) throw new ForbiddenException({ message: 'Pupil was removed from this session', code: 'REMOVED_FROM_SESSION' });
      if (mode !== 'NONE' && (!cur || cur.stage === 'NONE')) {
        const on = await tx.classParticipant.count({ where: { sessionId, stage: { not: 'NONE' }, removedAt: null } });
        if (on >= max) throw new ConflictException({ message: 'The stage is full', code: 'STAGE_FULL' });
      }
      await tx.classParticipant.upsert({
        where: { sessionId_pupilId: { sessionId, pupilId } },
        update: { stage: mode, stageAt: mode === 'NONE' ? null : this.clock.now(), handRaisedAt: null },
        create: { sessionId, pupilId, stage: mode, stageAt: mode === 'NONE' ? null : this.clock.now() },
      });
      return cur?.stage ?? 'NONE';
    });
    try {
      const room = classRoomName(sessionId);
      await this.provider.setParticipantPermission(room, pupilId, { canPublish: mode !== 'NONE', publishSources: sourcesFor(mode) });
      if (mode === 'NONE') await this.provider.muteParticipant(room, pupilId).catch(() => undefined);
      await this.provider.setParticipantAttributes(room, pupilId, { hand: '0', stage: mode }).catch(() => undefined);
    } catch (e: any) {
      // Server huquqni o'zgartira olmadi: bazani eski holatga qaytaramiz, "muvaffaqiyat" ko'rsatmaymiz
      await this.prisma.classParticipant.updateMany({ where: { sessionId, pupilId }, data: { stage: prev } });
      throw new BadGatewayException({ message: 'Could not change permissions on the media server', code: 'PROVIDER_ERROR' });
    }
  }

  private async activePupil(classId: string, pupilId: string) {
    const e = await this.prisma.classEnrollment.findFirst({ where: { classId, pupilId, status: 'ACTIVE' }, select: { id: true } });
    if (!e) throw new NotFoundException('Pupil not found');
  }
  private async liveForTeacher(actor: Actor, sessionId: string) {
    const r = await this.asTeacher(actor, sessionId);
    if (r.s.status !== 'LIVE') throw new ConflictException({ message: 'The class is not live', code: 'NOT_LIVE' });
    return r;
  }

  async grant(actor: Actor, sessionId: string, pupilId: string, mode: 'VOICE' | 'VOICE_VIDEO') {
    const { c } = await this.liveForTeacher(actor, sessionId);
    await this.activePupil(c.id, pupilId);
    await this.setStage(sessionId, pupilId, mode);
    await this.audit.log(actor, { action: 'class.stage.grant', targetType: 'ClassSession', targetId: sessionId, metadata: { pupilId, mode } });
    return this.state(actor, sessionId);
  }
  async revoke(actor: Actor, sessionId: string, pupilId: string) {
    const { c } = await this.liveForTeacher(actor, sessionId);
    await this.activePupil(c.id, pupilId);
    await this.setStage(sessionId, pupilId, 'NONE');
    await this.audit.log(actor, { action: 'class.stage.revoke', targetType: 'ClassSession', targetId: sessionId, metadata: { pupilId } });
    return this.state(actor, sessionId);
  }
  async takeStage(actor: Actor, sessionId: string) {
    const { s } = await this.liveParticipant(actor, sessionId);
    if (s.stageMode === 'LISTEN_ONLY') throw new ConflictException({ message: 'Nobody speaks in this mode', code: 'STAGE_CLOSED' });
    if (s.stageMode !== 'OPEN_STAGE') throw new ConflictException({ message: 'Raise your hand and wait for the teacher', code: 'NEEDS_APPROVAL' });
    if (s.locked) throw new ForbiddenException({ message: 'The room is locked', code: 'ROOM_LOCKED' });
    await this.setStage(sessionId, actor.id, 'VOICE_VIDEO');
    return this.state(actor, sessionId);
  }
  async stepDown(actor: Actor, sessionId: string) {
    await this.liveParticipant(actor, sessionId);
    await this.setStage(sessionId, actor.id, 'NONE');
    return this.state(actor, sessionId);
  }

  async setStageMode(actor: Actor, sessionId: string, mode: 'LISTEN_ONLY' | 'HAND_RAISE' | 'OPEN_STAGE') {
    const { s } = await this.asTeacher(actor, sessionId);
    if (s.status === 'ENDED' || s.status === 'CANCELLED') throw new ConflictException({ message: 'Session is over', code: 'SESSION_OVER' });
    await this.prisma.classSession.update({ where: { id: sessionId }, data: { stageMode: mode } });
    if (mode === 'LISTEN_ONLY') {
      const on = await this.prisma.classParticipant.findMany({ where: { sessionId, OR: [{ stage: { not: 'NONE' } }, { handRaisedAt: { not: null } }] } });
      for (const p of on) await this.setStage(sessionId, p.pupilId, 'NONE');
    }
    await this.audit.log(actor, { action: 'class.stage.mode', targetType: 'ClassSession', targetId: sessionId, metadata: { mode } });
    return this.state(actor, sessionId);
  }

  // ---------- o'qituvchi boshqaruvi ----------
  async muteAll(actor: Actor, sessionId: string) {
    await this.liveForTeacher(actor, sessionId);
    const on = await this.prisma.classParticipant.findMany({ where: { sessionId, stage: { not: 'NONE' }, removedAt: null } });
    for (const p of on) await this.provider.muteParticipant(classRoomName(sessionId), p.pupilId).catch((e) => this.log.warn(`mute: ${e.message}`));
    await this.audit.log(actor, { action: 'class.mute_all', targetType: 'ClassSession', targetId: sessionId });
    return { muted: on.length };
  }
  async mute(actor: Actor, sessionId: string, pupilId: string) {
    const { c } = await this.liveForTeacher(actor, sessionId);
    await this.activePupil(c.id, pupilId);
    await this.provider.muteParticipant(classRoomName(sessionId), pupilId);
    return { ok: true };
  }
  async spotlight(actor: Actor, sessionId: string, pupilId: string | null) {
    const { c, s } = await this.liveForTeacher(actor, sessionId);
    if (pupilId) await this.activePupil(c.id, pupilId);
    const room = classRoomName(sessionId);
    if (s.spotlightPupilId && s.spotlightPupilId !== pupilId) await this.provider.setParticipantAttributes(room, s.spotlightPupilId, { spotlight: '0' }).catch(() => undefined);
    await this.prisma.classSession.update({ where: { id: sessionId }, data: { spotlightPupilId: pupilId } });
    if (pupilId) await this.provider.setParticipantAttributes(room, pupilId, { spotlight: '1' }).catch(() => undefined);
    return this.state(actor, sessionId);
  }
  async removePupil(actor: Actor, sessionId: string, pupilId: string) {
    const { c } = await this.liveForTeacher(actor, sessionId);
    await this.activePupil(c.id, pupilId);
    await this.prisma.classParticipant.upsert({
      where: { sessionId_pupilId: { sessionId, pupilId } },
      update: { removedAt: this.clock.now(), stage: 'NONE', handRaisedAt: null },
      create: { sessionId, pupilId, removedAt: this.clock.now() },
    });
    await this.provider.removeParticipant(classRoomName(sessionId), pupilId).catch((e) => this.log.warn(`remove: ${e.message}`));
    await this.audit.log(actor, { action: 'class.session.remove_pupil', targetType: 'ClassSession', targetId: sessionId, metadata: { pupilId } });
    return { ok: true };
  }
  async lock(actor: Actor, sessionId: string, locked: boolean) {
    await this.asTeacher(actor, sessionId);
    await this.prisma.classSession.update({ where: { id: sessionId }, data: { locked } });
    await this.audit.log(actor, { action: locked ? 'class.session.lock' : 'class.session.unlock', targetType: 'ClassSession', targetId: sessionId });
    return this.state(actor, sessionId);
  }

  // ---------- ro'yxat va davomat ----------
  async roster(actor: Actor, sessionId: string) {
    const { c } = await this.asTeacher(actor, sessionId);
    const [enr, parts, att] = await Promise.all([
      this.prisma.classEnrollment.findMany({ where: { classId: c.id, status: 'ACTIVE' }, include: { pupil: { select: { id: true, name: true } } } }),
      this.prisma.classParticipant.findMany({ where: { sessionId } }),
      this.prisma.classAttendance.findMany({ where: { sessionId } }),
    ]);
    const rows = enr.map((e) => {
      const p = parts.find((x) => x.pupilId === e.pupilId);
      const a = att.find((x) => x.pupilId === e.pupilId);
      return { pupilId: e.pupilId, name: e.pupil.name, present: !!a?.presentNow, hand: !!p?.handRaisedAt, handRaisedAt: p?.handRaisedAt ?? null, stage: p?.stage ?? 'NONE', removed: !!p?.removedAt, quality: null as string | null };
    });
    rows.sort((x, y) => Number(y.hand) - Number(x.hand) || (x.handRaisedAt?.getTime() ?? 0) - (y.handRaisedAt?.getTime() ?? 0) || Number(y.stage !== 'NONE') - Number(x.stage !== 'NONE') || Number(y.present) - Number(x.present) || (x.name ?? '').localeCompare(y.name ?? ''));
    return rows;
  }

  async attendance(actor: Actor, sessionId: string) {
    const { c } = await this.asTeacher(actor, sessionId);
    const [enr, att] = await Promise.all([
      this.prisma.classEnrollment.findMany({ where: { classId: c.id, status: 'ACTIVE' }, include: { pupil: { select: { id: true, name: true } } } }),
      this.prisma.classAttendance.findMany({ where: { sessionId } }),
    ]);
    const now = this.clock.now();
    return enr.map((e) => {
      const a = att.find((x) => x.pupilId === e.pupilId);
      const live = a?.presentNow && a.lastJoinAt ? Math.round((now.getTime() - a.lastJoinAt.getTime()) / 1000) : 0;
      return { pupilId: e.pupilId, name: e.pupil.name, attended: !!a, totalSeconds: (a?.totalSeconds ?? 0) + live, joinCount: a?.joinCount ?? 0, joinedLate: a?.joinedLate ?? false, firstJoinedAt: a?.firstJoinedAt ?? null, presentNow: !!a?.presentNow };
    });
  }

  // ---------- provayder webhook'lari ----------
  async handleEvents(events: ProviderEvent[]) {
    const cfg = marketConfig();
    for (const e of events) {
      if (!e.roomName.startsWith('class-')) continue;
      const sessionId = e.roomName.slice('class-'.length);
      const key = `${e.type}|${e.roomName}|${e.identity ?? ''}|${e.at.getTime()}`;
      try {
        await this.prisma.classRoomEvent.create({ data: { eventKey: key, at: e.at } });
      } catch (err: any) {
        if (err?.code === 'P2002') continue; // takroriy hodisa
        throw err;
      }
      const s = await this.prisma.classSession.findUnique({ where: { id: sessionId }, include: { class: { include: { teacher: { select: { userId: true } } } } } });
      if (!s) continue;
      if (e.type === 'room_finished') {
        await this.closePresences(sessionId, e.at);
        continue;
      }
      if (!e.identity) continue;
      if (e.identity === s.class.teacher.userId) {
        if (s.status === 'LIVE') await this.prisma.classSession.update({ where: { id: sessionId }, data: { teacherAbsentSince: e.type === 'participant_left' ? e.at : null } });
        continue;
      }
      const enrolled = await this.prisma.classEnrollment.findFirst({ where: { classId: s.classId, pupilId: e.identity, status: 'ACTIVE' }, select: { id: true } });
      if (!enrolled) continue;
      const a = await this.prisma.classAttendance.findUnique({ where: { sessionId_pupilId: { sessionId, pupilId: e.identity } } });
      if (e.type === 'participant_joined') {
        if (a?.presentNow) continue;
        if (!a) await this.prisma.classAttendance.create({ data: { sessionId, pupilId: e.identity, firstJoinedAt: e.at, lastJoinAt: e.at, presentNow: true, joinCount: 1, joinedLate: e.at.getTime() > s.startAt.getTime() + cfg.classLateJoinMinutes * 60_000 } });
        else await this.prisma.classAttendance.update({ where: { id: a.id }, data: { presentNow: true, lastJoinAt: e.at, joinCount: a.joinCount + 1 } });
      } else if (e.type === 'participant_left') {
        if (!a?.presentNow) continue;
        const add = a.lastJoinAt ? Math.max(0, Math.round((e.at.getTime() - a.lastJoinAt.getTime()) / 1000)) : 0;
        await this.prisma.classAttendance.update({ where: { id: a.id }, data: { presentNow: false, lastLeftAt: e.at, totalSeconds: a.totalSeconds + add } });
      }
    }
  }

  // Tur enqueue chaqiruvida literal (shablon testi shuni qidiradi)
  private async notifyPupils(classId: string, send: (userId: string) => Promise<unknown>) {
    const rows = await this.prisma.classEnrollment.findMany({ where: { classId, status: 'ACTIVE' }, select: { pupilId: true } });
    for (const r of rows) await send(r.pupilId);
  }
}
