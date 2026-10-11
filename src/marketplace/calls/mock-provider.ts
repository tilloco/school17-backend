import { CallProvider, ClassTokenInput, MintedToken, MintTokenInput, ParticipantPermission, ProviderEvent } from './call-provider';
import { signHs256, verifyHs256 } from './jwt-hs256';

/**
 * Faqat development/test uchun. Hech qanday media uzatmaydi; tokenlar o'z maxfiy kaliti bilan imzolanadi.
 * Production'da ishga tushirishga YO'L QO'YILMAYDI (call-provider.factory.ts).
 */
export class MockCallProvider implements CallProvider {
  readonly name = 'mock';
  readonly presenceFromWebhooksOnly = false;
  readonly rooms = new Set<string>();
  readonly closed = new Set<string>();

  constructor(private secret = 'mock-call-secret-not-real', private url = 'mock://call') {}

  async ensureRoom(roomName: string) {
    if (this.closed.has(roomName)) throw new Error('Room closed');
    this.rooms.add(roomName);
  }

  async mintToken(i: MintTokenInput): Promise<MintedToken> {
    const exp = Math.floor(i.now.getTime() / 1000) + i.ttlSeconds;
    const token = signHs256(
      { room: i.roomName, sub: i.identity, name: i.displayName, exp, nbf: Math.floor(i.now.getTime() / 1000) - 5, data: i.canPublishData },
      this.secret,
    );
    return { token, url: this.url, expiresAt: new Date(exp * 1000) };
  }

  // ---- sinf xonasi (R2): test uchun holatni eslab qoladi ----
  readonly classRooms = new Map<string, { max: number }>();
  readonly permissions = new Map<string, ParticipantPermission>(); // `${room}|${identity}`
  readonly attributes = new Map<string, Record<string, string>>();
  readonly muted: string[] = [];
  readonly removed: string[] = [];

  async ensureClassRoom(roomName: string, maxParticipants: number) {
    if (this.closed.has(roomName)) throw new Error('Room closed');
    this.classRooms.set(roomName, { max: maxParticipants });
  }
  async mintClassToken(i: ClassTokenInput): Promise<MintedToken> {
    const iat = Math.floor(i.now.getTime() / 1000);
    const exp = iat + i.ttlSeconds;
    const video = i.isTeacher
      ? { roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true, canUpdateOwnMetadata: true }
      : { roomJoin: true, canPublish: i.publishSources.length > 0, canPublishSources: i.publishSources, canSubscribe: true, canPublishData: false, canUpdateOwnMetadata: false };
    const token = signHs256({ room: i.roomName, sub: i.identity, name: i.displayName, exp, nbf: iat - 5, video }, this.secret);
    return { token, url: this.url, expiresAt: new Date(exp * 1000) };
  }
  async setParticipantPermission(roomName: string, identity: string, perm: ParticipantPermission) {
    this.permissions.set(`${roomName}|${identity}`, perm);
  }
  async setParticipantAttributes(roomName: string, identity: string, attrs: Record<string, string>) {
    this.attributes.set(`${roomName}|${identity}`, { ...(this.attributes.get(`${roomName}|${identity}`) ?? {}), ...attrs });
  }
  async muteParticipant(roomName: string, identity: string) {
    this.muted.push(`${roomName}|${identity}`);
  }
  async removeParticipant(roomName: string, identity: string) {
    this.removed.push(`${roomName}|${identity}`);
  }

  /** Test yordamchisi: provayder tomondan token yaroqliligi (xona yopilganmi, muddati o'tmaganmi) */
  verifyToken(token: string, now: Date) {
    const p = verifyHs256(token, this.secret, now);
    if (!p || this.closed.has(p.room)) return null;
    return p as { room: string; sub: string; name: string; exp: number };
  }

  async closeRoom(roomName: string) {
    this.rooms.delete(roomName);
    this.closed.add(roomName);
  }

  parseWebhook(rawBody: string): ProviderEvent[] {
    const j = JSON.parse(rawBody);
    return [{ type: j.type, roomName: j.roomName, identity: j.identity, at: new Date(j.at ?? Date.now()) }];
  }
}
