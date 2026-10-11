export interface MintTokenInput {
  roomName: string;
  identity: string;
  displayName: string;
  ttlSeconds: number;
  now: Date;
  canPublishData: boolean;
}

/** Sinf xonasi tokeni (R2). O'quvchi: ko'rish rejimi; faqat backend bergan sahna huquqi bilan nashr qila oladi. */
export type PublishSource = 'microphone' | 'camera';
export interface ClassTokenInput {
  roomName: string;
  identity: string;
  displayName: string; // faqat ism
  ttlSeconds: number;
  now: Date;
  isTeacher: boolean;
  /** O'quvchining joriy sahna huquqi (qayta ulanishda token shu huquq bilan beriladi) */
  publishSources: PublishSource[];
}
export interface ParticipantPermission {
  canPublish: boolean;
  publishSources: PublishSource[];
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
  /** Sinf xonasi (R2): ko'p ishtirokchili */
  ensureClassRoom(roomName: string, maxParticipants: number): Promise<void>;
  mintClassToken(input: ClassTokenInput): Promise<MintedToken>;
  /** Serverda bitta ishtirokchining nashr huquqini o'zgartiradi (klientga ishonilmaydi) */
  setParticipantPermission(roomName: string, identity: string, perm: ParticipantPermission): Promise<void>;
  /** Ishtirokchi atributlari (masalan hand=1): o'qituvchi ro'yxati jonli yangilanadi */
  setParticipantAttributes(roomName: string, identity: string, attributes: Record<string, string>): Promise<void>;
  /** Ishtirokchining mikrofon treklarini o'chiradi */
  muteParticipant(roomName: string, identity: string): Promise<void>;
  removeParticipant(roomName: string, identity: string): Promise<void>;
  /** Webhook imzosini tekshiradi; noto'g'ri bo'lsa xato tashlaydi */
  parseWebhook(rawBody: string, authHeader: string | undefined): ProviderEvent[];
}
