import { CallProvider, ClassTokenInput, MintedToken, MintTokenInput, ParticipantPermission, ProviderEvent } from './call-provider';
import { sha256Base64, signHs256, verifyHs256 } from './jwt-hs256';

/**
 * LiveKit adapteri (token + REST Twirp + webhook).
 * HOLAT: UNTESTED — haqiqiy LiveKit serveri/kalitlari bilan sinab ko'rilmagan (KNOWN_GAPS.md).
 * Faqat token tuzilmasi va webhook imzosi lokal unit testlarda tekshirilgan.
 * Env: LIVEKIT_URL (wss://...), LIVEKIT_HTTP_URL (ixtiyoriy, https://...), LIVEKIT_API_KEY, LIVEKIT_API_SECRET.
 */
export class LiveKitCallProvider implements CallProvider {
  readonly name = 'livekit';
  readonly presenceFromWebhooksOnly = true;
  private httpUrl: string;

  constructor(
    private wsUrl: string,
    private apiKey: string,
    private apiSecret: string,
    httpUrl?: string,
    private fetchFn: typeof fetch = fetch,
  ) {
    this.httpUrl = httpUrl ?? wsUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  }

  private adminToken(now: Date, grants: Record<string, unknown>) {
    const iat = Math.floor(now.getTime() / 1000);
    return signHs256({ iss: this.apiKey, nbf: iat - 5, exp: iat + 60, video: grants }, this.apiSecret);
  }

  private async twirp(method: string, body: unknown, grants: Record<string, unknown>) {
    const res = await this.fetchFn(`${this.httpUrl}/twirp/livekit.RoomService/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.adminToken(new Date(), grants)}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`LiveKit ${method} failed: ${res.status}`);
    return res.json().catch(() => ({}));
  }

  async ensureRoom(roomName: string) {
    // empty_timeout: bo'sh xona 5 daqiqadan keyin o'chadi; max_participants: 2 (faqat o'qituvchi va o'quvchi)
    await this.twirp('CreateRoom', { name: roomName, empty_timeout: 300, max_participants: 2 }, { roomCreate: true });
  }

  async mintToken(i: MintTokenInput): Promise<MintedToken> {
    const iat = Math.floor(i.now.getTime() / 1000);
    const exp = iat + i.ttlSeconds;
    const token = signHs256(
      {
        iss: this.apiKey,
        sub: i.identity,
        name: i.displayName,
        nbf: iat - 5,
        exp,
        video: { room: i.roomName, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: i.canPublishData },
      },
      this.apiSecret,
    );
    return { token, url: this.wsUrl, expiresAt: new Date(exp * 1000) };
  }

  // ---- sinf xonasi (R2). HOLAT: UNTESTED haqiqiy serverda; yo'llar va maydonlar joriy hujjatlardan (docs.livekit.io, Twirp RoomService) ----
  async ensureClassRoom(roomName: string, maxParticipants: number) {
    // 31 = o'qituvchi + 30 o'quvchi; bo'sh xona 5 daqiqadan keyin o'chadi
    await this.twirp('CreateRoom', { name: roomName, empty_timeout: 300, max_participants: maxParticipants }, { roomCreate: true });
  }
  async mintClassToken(i: ClassTokenInput): Promise<MintedToken> {
    const iat = Math.floor(i.now.getTime() / 1000);
    const exp = iat + i.ttlSeconds;
    const video = i.isTeacher
      ? { room: i.roomName, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true, canUpdateOwnMetadata: true }
      : { room: i.roomName, roomJoin: true, canPublish: i.publishSources.length > 0, canPublishSources: i.publishSources, canSubscribe: true, canPublishData: false, canUpdateOwnMetadata: false };
    const token = signHs256({ iss: this.apiKey, sub: i.identity, name: i.displayName, nbf: iat - 5, exp, video }, this.apiSecret);
    return { token, url: this.wsUrl, expiresAt: new Date(exp * 1000) };
  }
  async setParticipantPermission(roomName: string, identity: string, perm: ParticipantPermission) {
    // TrackSource: CAMERA=1, MICROPHONE=2
    const sources = perm.publishSources.map((s) => (s === 'camera' ? 1 : 2));
    await this.twirp('UpdateParticipant', { room: roomName, identity, permission: { canSubscribe: true, canPublish: perm.canPublish, canPublishData: false, canPublishSources: sources } }, { roomAdmin: true, room: roomName });
  }
  async setParticipantAttributes(roomName: string, identity: string, attributes: Record<string, string>) {
    await this.twirp('UpdateParticipant', { room: roomName, identity, attributes }, { roomAdmin: true, room: roomName });
  }
  async muteParticipant(roomName: string, identity: string) {
    const p: any = await this.twirp('GetParticipant', { room: roomName, identity }, { roomAdmin: true, room: roomName });
    for (const tr of p?.tracks ?? []) {
      if (tr.type === 'AUDIO' || tr.type === 0) await this.twirp('MutePublishedTrack', { room: roomName, identity, track_sid: tr.sid, muted: true }, { roomAdmin: true, room: roomName });
    }
  }
  async removeParticipant(roomName: string, identity: string) {
    await this.twirp('RemoveParticipant', { room: roomName, identity }, { roomAdmin: true, room: roomName });
  }

  async closeRoom(roomName: string) {
    await this.twirp('DeleteRoom', { room: roomName }, { roomCreate: true });
  }

  parseWebhook(rawBody: string, authHeader: string | undefined): ProviderEvent[] {
    if (!authHeader) throw new Error('Missing signature');
    const claims = verifyHs256(authHeader.replace(/^Bearer\s+/i, ''), this.apiSecret, new Date());
    if (!claims || claims.iss !== this.apiKey) throw new Error('Bad signature');
    if (claims.sha256 !== sha256Base64(rawBody)) throw new Error('Body hash mismatch');
    const j = JSON.parse(rawBody);
    const at = new Date(((j.createdAt as number) ?? Math.floor(Date.now() / 1000)) * 1000);
    const room = j.room?.name as string | undefined;
    if (!room) return [];
    switch (j.event) {
      case 'participant_joined': return [{ type: 'participant_joined', roomName: room, identity: j.participant?.identity, at }];
      case 'participant_left': return [{ type: 'participant_left', roomName: room, identity: j.participant?.identity, at }];
      case 'room_finished': return [{ type: 'room_finished', roomName: room, at }];
      default: return [];
    }
  }
}
