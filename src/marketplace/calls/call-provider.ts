export interface MintTokenInput {
  roomName: string;
  identity: string;
  displayName: string;
  ttlSeconds: number;
  now: Date;
  canPublishData: boolean;
}

export interface MintedToken {
  token: string;
  url: string;
  expiresAt: Date;
}

export interface ProviderEvent {
  type: 'participant_joined' | 'participant_left' | 'room_finished';
  roomName: string;
  identity?: string;
  at: Date;
}

export const CALL_PROVIDER = Symbol('CALL_PROVIDER');

/**
 * Real-time video provayderi abstraksiyasi. Media serverni O'ZIMIZ yozmaymiz: haqiqiy adapter (LiveKit)
 * tashqi serverga ulanadi. Mock adapter faqat dev/test uchun.
 */
export interface CallProvider {
  readonly name: string;
  /** true bo'lsa, presence faqat provayder webhook'laridan olinadi (mijoz heartbeat'iga ishonilmaydi) */
  readonly presenceFromWebhooksOnly: boolean;
  ensureRoom(roomName: string): Promise<void>;
  mintToken(input: MintTokenInput): Promise<MintedToken>;
  /** Xonani yopadi va barcha ishtirokchilarni chiqarib yuboradi (bekor qilish/ko'chirishda) */
  closeRoom(roomName: string): Promise<void>;
  /** Webhook imzosini tekshiradi; noto'g'ri bo'lsa xato tashlaydi */
  parseWebhook(rawBody: string, authHeader: string | undefined): ProviderEvent[];
}
