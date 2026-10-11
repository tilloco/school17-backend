import { CallProvider, MintedToken, MintTokenInput, ProviderEvent } from './call-provider';
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
