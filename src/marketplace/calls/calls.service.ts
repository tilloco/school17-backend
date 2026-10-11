import {
  ConflictException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit,
} from '@nestjs/common';
import { Booking, CallRoom, CallSession, Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor, ADULT_AGE, ageInYears } from '../common/actor';
import { AuditService } from '../common/audit.service';
import { ClockService } from '../common/clock';
import { marketConfig } from '../common/config';
import { DomainEvents } from '../common/events';
import { displayName, isJoinWindowOpen, joinWindow } from '../booking/booking-rules';
import { BookingService } from '../booking/booking.service';
import { CALL_PROVIDER, CallProvider, ProviderEvent } from './call-provider';
import { decideOutcome, recordingAllowed, SessionLike } from './presence';

export type JoinDenyReason = 'NOT_CONFIRMED' | 'TOO_EARLY' | 'WINDOW_CLOSED';
export type PresenceEvent = 'joined' | 'heartbeat' | 'left';

export interface QualityReport {
  rttMs?: number;
  lossPct?: number;
  bitrateKbps?: number;
  tier?: 'good' | 'fair' | 'poor' | 'audio_only';
  joinMs?: number;
  reconnects?: number;
}

type Side = 'TEACHER' | 'STUDENT';
type BookingFull = Booking & {
  teacher: { id: string; userId: string; user: { name: string | null } };
  student: { id: string; name: string | null; dateOfBirth: Date | null; status: string };
};

const newRoomName = () => `r_${randomBytes(16).toString('hex')}`; // 128 bit — taxmin qilib bo'lmaydi
const newKey = () => `p_${randomBytes(8).toString('hex')}`;

const clientHints = () => ({
  heartbeatSeconds: 15,
  // Mijoz tomonidagi tavsiya etilgan chegaralar (call-machine.ts bilan bir xil)
  audioOnlyAfterPoorSamples: 3,
  reconnectGraceSeconds: 45,
  maxVideo: { width: 640, height: 360, fps: 24, kbps: 600 }, // o'rtacha tarmoqlar uchun konservativ
});

@Injectable()
export class CallsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Calls');
  private timer?: NodeJS.Timeout;

  constructor(
    private prisma: PrismaService,
    private clock: ClockService,
    private audit: AuditService,
    private bookings: BookingService,
    private events: DomainEvents,
    @Inject(CALL_PROVIDER) private provider: CallProvider,
  ) {}

  onModuleInit() {
    this.events.on('booking.cancelled', ({ bookingId }) => this.revoke(bookingId, 'booking_cancelled'));
    this.events.on('booking.rescheduled', ({ bookingId }) => this.revoke(bookingId, 'booking_rescheduled'));
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.finalizeDue().catch((e) => this.log.error(e.message)), 30_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // ---------- kirish huquqi ----------

  /** Faqat ikki ishtirokchi (o'qituvchi va o'quvchi). Bronlovchi vasiy ishtirokchi EMAS. Boshqalarga 404. */
  private async participantBooking(actor: Actor, bookingId: string): Promise<{ b: BookingFull; side: Side }> {
    const b = (await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        teacher: { select: { id: true, userId: true, user: { select: { name: true } } } },
        student: { select: { id: true, name: true, dateOfBirth: true, status: true } },
      },
    })) as BookingFull | null;
    if (!b) throw new NotFoundException('Not found');
    let side: Side | null = null;
    if (b.teacher.userId === actor.id) side = 'TEACHER';
    else if (b.studentId === actor.id) side = 'STUDENT';
    if (!side) throw new NotFoundException('Not found');
    return { b, side };
  }

  private joinState(b: Booking, now: Date): { canJoin: boolean; reason?: JoinDenyReason } {
    if (b.status !== 'CONFIRMED') return { canJoin: false, reason: 'NOT_CONFIRMED' };
    const w = joinWindow(b.startAt, b.endAt);
    if (now < w.opensAt) return { canJoin: false, reason: 'TOO_EARLY' };
    if (now > w.closesAt) return { canJoin: false, reason: 'WINDOW_CLOSED' };
    return { canJoin: true };
  }

  private otherName(b: BookingFull, side: Side, now: Date): string {
    if (side === 'STUDENT') return b.teacher.user.name ?? '—';
    const minor = b.student.dateOfBirth ? ageInYears(b.student.dateOfBirth, now) < ADULT_AGE : false;
    return displayName(b.student.name, minor);
  }

  async lobby(actor: Actor, bookingId: string) {
    const { b, side } = await this.participantBooking(actor, bookingId);
    const now = this.clock.now();
    const w = joinWindow(b.startAt, b.endAt);
    const st = this.joinState(b, now);
    return {
      bookingId: b.id,
      status: b.status,
      mySide: side,
      other: { name: this.otherName(b, side, now) },
      startAt: b.startAt,
      endAt: b.endAt,
      joinWindow: { opensAt: w.opensAt, closesAt: w.closesAt },
      serverTime: now,
      canJoin: st.canJoin,
      reason: st.reason ?? null,
      provider: this.provider.name,
      clientHints: clientHints(),
      recording: { enabledByDefault: false },
    };
  }

  // ---------- token ----------

  async issueToken(actor: Actor, bookingId: string) {
    const { b, side } = await this.participantBooking(actor, bookingId);
    const now = this.clock.now();
    const st = this.joinState(b, now);
    if (!st.canJoin) {
      const w = joinWindow(b.startAt, b.endAt);
      throw new HttpException({ statusCode: 409, message: 'Join not allowed', code: st.reason, opensAt: w.opensAt, closesAt: w.closesAt }, HttpStatus.CONFLICT);
    }
    if (b.student.status !== 'ACTIVE') throw new ConflictException('Participant unavailable');
    const room = await this.activeRoom(b);
    const w = joinWindow(b.startAt, b.endAt);
    const ttl = Math.max(30, Math.min(marketConfig().callTokenTtlSeconds, Math.floor((w.closesAt.getTime() - now.getTime()) / 1000)));
    const identity = side === 'TEACHER' ? room.teacherKey : room.studentKey;
    const minted = await this.provider.mintToken({
      roomName: room.roomName, identity, displayName: this.ownDisplayName(b, side, now), ttlSeconds: ttl, now, canPublishData: true,
    });
    await this.prisma.callTokenIssue.create({ data: { roomId: room.id, userId: actor.id, expiresAt: minted.expiresAt } });
    await this.logEvent(b.id, actor.id, 'token_issued', { side });
    return { url: minted.url, token: minted.token, identity, expiresAt: minted.expiresAt, provider: this.provider.name, clientHints: clientHints() };
  }

  private ownDisplayName(b: BookingFull, side: Side, now: Date): string {
    if (side === 'TEACHER') return b.teacher.user.name ?? 'Teacher';
    const minor = b.student.dateOfBirth ? ageInYears(b.student.dateOfBirth, now) < ADULT_AGE : false;
    return displayName(b.student.name, minor);
  }

  private async activeRoom(b: Booking): Promise<CallRoom> {
    let room = await this.prisma.callRoom.findFirst({ where: { bookingId: b.id, status: 'ACTIVE' }, orderBy: { createdAt: 'desc' } });
    if (!room) {
      try {
        room = await this.prisma.callRoom.create({
          data: { bookingId: b.id, roomName: newRoomName(), provider: this.provider.name, teacherKey: newKey(), studentKey: newKey() },
        });
      } catch (e: any) {
        // Ikkala ishtirokchi bir vaqtda token so'rasa: yagona faol xona indeksi (P2002) ikkinchisini mavjud xonaga yo'naltiradi
        if (e?.code !== 'P2002') throw e;
        room = await this.prisma.callRoom.findFirst({ where: { bookingId: b.id, status: 'ACTIVE' } });
        if (!room) throw e;
      }
    }
    await this.provider.ensureRoom(room.roomName);
    return room;
  }

  // ---------- presence ----------

  async presence(actor: Actor, bookingId: string, event: PresenceEvent, quality?: QualityReport) {
    const { b, side } = await this.participantBooking(actor, bookingId);
    const now = this.clock.now();
    if (quality) await this.logEvent(b.id, actor.id, 'quality', { ...quality, event });
    if (this.provider.presenceFromWebhooksOnly) {
      // Haqiqiy provayderda qatnashishni mijoz da'vo qila olmaydi (soxta "keldi" bilan pul olishning oldini oladi)
      return { accepted: false, reason: 'presence_from_provider' };
    }
    const room = await this.prisma.callRoom.findFirst({ where: { bookingId: b.id, status: 'ACTIVE' }, orderBy: { createdAt: 'desc' } });
    if (!room) throw new ConflictException('No active room; request a token first');
    if (event === 'joined') {
      if (!this.joinState(b, now).canJoin) throw new ConflictException('Join window closed');
      await this.openSession(room, b.id, actor.id, side, now, 'CLIENT');
    } else {
      const open = await this.prisma.callSession.findFirst({ where: { roomId: room.id, userId: actor.id, leftAt: null }, orderBy: { joinedAt: 'desc' } });
      if (!open) throw new ConflictException('Not joined');
      await this.prisma.callSession.update({
        where: { id: open.id },
        data: event === 'left' ? { leftAt: now, lastSeenAt: now, endReason: 'left' } : { lastSeenAt: now },
      });
      if (event === 'left') {
        await this.logEvent(b.id, actor.id, 'left', { side });
        await this.tryFinalize(b.id);
      }
    }
    return { accepted: true };
  }

  /** Qayta ulanishda eski ochiq sessiya oxirgi signal vaqtida yopiladi, yangisi ochiladi. */
  private async openSession(room: CallRoom, bookingId: string, userId: string, side: Side, now: Date, source: 'CLIENT' | 'PROVIDER') {
    const stale = await this.prisma.callSession.findMany({ where: { roomId: room.id, userId, leftAt: null } });
    for (const s of stale) {
      await this.prisma.callSession.update({ where: { id: s.id }, data: { leftAt: s.lastSeenAt, endReason: 'reconnect' } });
    }
    await this.prisma.callSession.create({ data: { roomId: room.id, bookingId, userId, side, source, joinedAt: now, lastSeenAt: now } });
    await this.logEvent(bookingId, userId, stale.length ? 'rejoined' : 'joined', { side, source });
  }

  async end(actor: Actor, bookingId: string) {
    const { b } = await this.participantBooking(actor, bookingId);
    const now = this.clock.now();
    await this.prisma.callSession.updateMany({ where: { bookingId: b.id, userId: actor.id, leftAt: null }, data: { leftAt: now, lastSeenAt: now, endReason: 'ended' } });
    await this.logEvent(b.id, actor.id, 'end_clicked', {});
    await this.tryFinalize(b.id);
    return this.summary(actor, bookingId);
  }

  // ---------- natijani yakunlash ----------

  private async sessionsBySide(bookingId: string): Promise<{ teacher: SessionLike[]; student: SessionLike[] }> {
    const rows: CallSession[] = await this.prisma.callSession.findMany({ where: { bookingId } });
    return { teacher: rows.filter((r) => r.side === 'TEACHER'), student: rows.filter((r) => r.side === 'STUDENT') };
  }

  async tryFinalize(bookingId: string) {
    const b = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!b || b.status !== 'CONFIRMED') return null;
    const now = this.clock.now();
    const w = joinWindow(b.startAt, b.endAt);
    const s = await this.sessionsBySide(bookingId);
    const out = decideOutcome({ ...s, startAt: b.startAt, endAt: b.endAt, opensAt: w.opensAt, closesAt: w.closesAt, now });
    if (out.kind === 'PENDING') return null;
    const extra: Prisma.BookingUpdateInput = { outcomeNote: out.note, actualDurationSec: out.billableSeconds };
    if (out.kind === 'COMPLETED') await this.bookings.systemTransition(bookingId, 'complete', extra);
    else if (out.kind === 'NO_SHOW_STUDENT') await this.bookings.systemTransition(bookingId, 'noShowStudent', extra);
    else if (out.kind === 'NO_SHOW_TEACHER') await this.bookings.systemTransition(bookingId, 'noShowTeacher', extra);
    else await this.bookings.systemTransition(bookingId, 'fail', extra);
    await this.endRooms(bookingId);
    await this.logEvent(bookingId, null, 'finalized', { kind: out.kind, note: out.note, billableSeconds: out.billableSeconds, overlap: out.overlapSeconds });
    if (out.kind === 'COMPLETED') await this.events.emit('booking.completed', { bookingId, billableSeconds: out.billableSeconds });
    else if (out.kind === 'FAILED') await this.events.emit('booking.failed', { bookingId, note: out.note });
    else await this.events.emit('booking.noshow', { bookingId, kind: out.kind });
    return out;
  }

  /** Davriy: dars vaqti o'tgan, hali CONFIRMED bronlarni yakunlaydi (kimdir ulanmay qolgan/ilova yopilgan holatlar). */
  async finalizeDue(limit = 100): Promise<number> {
    const now = this.clock.now();
    const rows = await this.prisma.booking.findMany({ where: { status: 'CONFIRMED', endAt: { lte: now } }, select: { id: true }, take: limit });
    let n = 0;
    for (const r of rows) if (await this.tryFinalize(r.id)) n++;
    return n;
  }

  private async endRooms(bookingId: string) {
    const rooms = await this.prisma.callRoom.findMany({ where: { bookingId, status: 'ACTIVE' } });
    for (const r of rooms) {
      await this.prisma.callRoom.update({ where: { id: r.id }, data: { status: 'ENDED', endedAt: this.clock.now() } });
      await this.provider.closeRoom(r.roomName).catch((e) => this.log.warn(`closeRoom failed: ${e.message}`));
    }
  }

  async summary(actor: Actor, bookingId: string) {
    const { b, side } = await this.participantBooking(actor, bookingId);
    const fresh = await this.prisma.booking.findUniqueOrThrow({ where: { id: b.id } });
    const now = this.clock.now();
    const w = joinWindow(b.startAt, b.endAt);
    const s = await this.sessionsBySide(b.id);
    const out = decideOutcome({ ...s, startAt: b.startAt, endAt: b.endAt, opensAt: w.opensAt, closesAt: w.closesAt, now });
    const mine = side === 'TEACHER' ? out.teacherSeconds : out.studentSeconds;
    return {
      bookingId: b.id,
      status: fresh.status,
      finalized: fresh.status !== 'CONFIRMED',
      scheduledSeconds: Math.floor((b.endAt.getTime() - b.startAt.getTime()) / 1000),
      mySeconds: mine,
      togetherSeconds: out.overlapSeconds,
      billableSeconds: fresh.status === 'COMPLETED' ? fresh.actualDurationSec ?? 0 : fresh.status === 'CONFIRMED' ? Math.min(out.overlapSeconds, Math.floor((b.endAt.getTime() - b.startAt.getTime()) / 1000)) : 0,
      outcome: fresh.status === 'CONFIRMED' ? out.kind : fresh.status,
      note: fresh.outcomeNote ?? out.note,
      canRejoin: this.joinState(fresh, now).canJoin,
    };
  }

  // ---------- bekor qilish / ko'chirish ----------

  /** Xonani bekor qiladi, tokenlarni bekor deb belgilaydi va provayderdagi xonani yopadi. */
  async revoke(bookingId: string, reason: string) {
    const now = this.clock.now();
    const rooms = await this.prisma.callRoom.findMany({ where: { bookingId, status: 'ACTIVE' } });
    for (const r of rooms) {
      await this.prisma.callRoom.update({ where: { id: r.id }, data: { status: 'REVOKED', revokedAt: now } });
      await this.prisma.callTokenIssue.updateMany({ where: { roomId: r.id, revokedAt: null }, data: { revokedAt: now } });
      await this.prisma.callSession.updateMany({ where: { roomId: r.id, leftAt: null }, data: { leftAt: now, endReason: reason } });
      await this.provider.closeRoom(r.roomName).catch((e) => this.log.warn(`closeRoom failed: ${e.message}`));
    }
    if (rooms.length) await this.logEvent(bookingId, null, 'revoked', { reason });
  }

  // ---------- provayder webhook ----------

  async handleProviderEvents(events: ProviderEvent[]) {
    for (const e of events) {
      const room = await this.prisma.callRoom.findUnique({ where: { roomName: e.roomName } });
      if (!room) continue;
      const side: Side | null = e.identity === room.teacherKey ? 'TEACHER' : e.identity === room.studentKey ? 'STUDENT' : null;
      if (e.type === 'participant_joined' && side) {
        const b = await this.prisma.booking.findUniqueOrThrow({ where: { id: room.bookingId }, include: { teacher: true } });
        const userId = side === 'TEACHER' ? b.teacher.userId : b.studentId;
        if (room.status === 'ACTIVE') await this.openSession(room, room.bookingId, userId, side, e.at, 'PROVIDER');
      } else if (e.type === 'participant_left' && side) {
        await this.prisma.callSession.updateMany({
          where: { roomId: room.id, side, leftAt: null }, data: { leftAt: e.at, lastSeenAt: e.at, endReason: 'provider_left' },
        });
        await this.tryFinalize(room.bookingId);
      } else if (e.type === 'room_finished') {
        await this.prisma.callSession.updateMany({ where: { roomId: room.id, leftAt: null }, data: { leftAt: e.at, endReason: 'room_finished' } });
        await this.tryFinalize(room.bookingId);
      }
    }
  }

  // ---------- yozib olish (standart O'CHIQ) ----------

  async setRecordingConsent(actor: Actor, bookingId: string, consent: boolean) {
    const { b, side } = await this.participantBooking(actor, bookingId);
    const room = await this.activeRoom(b);
    await this.prisma.callRoom.update({
      where: { id: room.id },
      data: side === 'TEACHER' ? { recordingConsentTeacher: consent } : { recordingConsentStudent: consent },
    });
    await this.audit.log(actor, { action: 'call.recording_consent', targetType: 'Booking', targetId: b.id, metadata: { side, consent } });
    return this.recordingStatus(actor, bookingId);
  }

  async recordingStatus(actor: Actor, bookingId: string) {
    const { b } = await this.participantBooking(actor, bookingId);
    const room = await this.prisma.callRoom.findFirst({ where: { bookingId: b.id, status: 'ACTIVE' } });
    const anyMinor = b.student.dateOfBirth ? ageInYears(b.student.dateOfBirth, this.clock.now()) < ADULT_AGE : true; // sana noma'lum => minor deb hisoblaymiz
    const policy = recordingAllowed({ anyMinor, teacherConsent: room?.recordingConsentTeacher ?? null, studentConsent: room?.recordingConsentStudent ?? null });
    return { recording: false, allowedByPolicy: policy.allowed, reason: policy.reason, note: 'Recording is not implemented; consent is stored only.' };
  }

  async startRecording(actor: Actor, bookingId: string) {
    const st = await this.recordingStatus(actor, bookingId);
    if (!st.allowedByPolicy) throw new ForbiddenException(st.reason);
    throw new HttpException('Recording is not implemented', HttpStatus.NOT_IMPLEMENTED);
  }

  // ---------- admin / jurnal ----------

  adminEvents(bookingId: string) {
    return this.prisma.callEvent.findMany({ where: { bookingId }, orderBy: { at: 'asc' }, take: 1000 });
  }

  private logEvent(bookingId: string, userId: string | null, type: string, data: Record<string, unknown>) {
    return this.prisma.callEvent.create({ data: { bookingId, userId, type, data: data as Prisma.InputJsonValue, at: this.clock.now() } });
  }

  /** Provayder bu service orqali webhook'ni tekshiradi (controller uchun) */
  parseWebhook(raw: string, auth: string | undefined) {
    if (this.provider.name === 'mock') throw new NotFoundException('Not found');
    return this.provider.parseWebhook(raw, auth);
  }
}
