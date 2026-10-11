// Marketplace sozlamalari. Hammasi env orqali o'zgartiriladi (nomlari DECISIONS/README da), standart qiymatlar xavfsiz.
function int(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== undefined && process.env[name] !== '' ? Math.trunc(v) : def;
}

export function marketConfig() {
  return {
    // Narx chegaralari, tiyin (1 so'm = 100 tiyin): 20 000 so'm .. 1 000 000 so'm / 60 daqiqa
    minPriceMinor: int('MARKET_MIN_PRICE_MINOR', 2_000_000),
    maxPriceMinor: int('MARKET_MAX_PRICE_MINOR', 100_000_000),
    lessonDurationsMin: [30, 45, 60, 90],
    // Bron
    minNoticeMinutes: int('BOOKING_MIN_NOTICE_MINUTES', 60),
    maxAdvanceDays: int('BOOKING_MAX_ADVANCE_DAYS', 60),
    requestExpiryHours: int('BOOKING_REQUEST_EXPIRY_HOURS', 24),
    freeCancelHours: int('BOOKING_FREE_CANCEL_HOURS', 12),
    lateCancelRefundBps: int('BOOKING_LATE_CANCEL_REFUND_BPS', 0), // 10000 = 100%
    // Qo'ng'iroq oynasi
    joinOpensMinutesBefore: int('CALL_JOIN_OPENS_MINUTES_BEFORE', 5),
    joinClosesMinutesAfterEnd: int('CALL_JOIN_CLOSES_MINUTES_AFTER_END', 5),
    callTokenTtlSeconds: int('CALL_TOKEN_TTL_SECONDS', 600),
    noShowGraceMinutes: int('CALL_NOSHOW_GRACE_MINUTES', 10),
    minLessonSeconds: int('CALL_MIN_LESSON_SECONDS', 300), // shundan kam birga bo'lish = dars o'tmagan
    presentMinSeconds: int('CALL_PRESENT_MIN_SECONDS', 60), // shuncha turgan tomon "keldi" hisoblanadi
    presenceStaleSeconds: int('CALL_PRESENCE_STALE_SECONDS', 45),
    // Komissiya (bazis punkt: 1500 = 15%)
    commissionBps: int('PLATFORM_COMMISSION_BPS', 1500),
  };
}
