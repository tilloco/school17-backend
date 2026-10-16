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
    // Sinflar (R1)
    classMaxPupils: int('CLASS_MAX_PUPILS', 500), // bir sinfdagi o'quvchilar soni chegarasi (o'qituvchi capacity'ni 1..shu oraliqda tanlaydi)
    classMaxStagePupils: int('CLASS_MAX_STAGE_PUPILS', 10), // bir vaqtda sahnadagi o'quvchilar (R2)
    classJoinAttemptsPerHour: int('CLASS_JOIN_ATTEMPTS_PER_HOUR', 10), // kod/havola bilan qo'shilish urinishlari, bir foydalanuvchiga
    classLobbyMinutes: int('CLASS_LOBBY_MINUTES', 10), // kutish xonasi darsdan necha daqiqa oldin ochiladi
    classTokenTtlSeconds: int('CLASS_TOKEN_TTL_SECONDS', 900), // xona tokenining umri; sessiya ochiq ekan qayta olinadi
    classTeacherNoShowMinutes: int('CLASS_TEACHER_NOSHOW_MINUTES', 15), // o'qituvchi boshlamasa, shundan keyin sessiya "kelmadi" bilan yopiladi
    classTeacherDropSeconds: int('CLASS_TEACHER_DROP_SECONDS', 300), // o'qituvchi uzilib qolsa xona shuncha vaqt ochiq turadi
    classLateJoinMinutes: int('CLASS_LATE_JOIN_MINUTES', 5), // boshlanishdan keyin shuncha daqiqadan kech kirish "kechikdi" hisoblanadi
    classOverrunMinutes: int('CLASS_OVERRUN_MINUTES', 30), // tugash vaqtidan keyin shuncha o'tsa, sessiya o'zi yopiladi
    classHorizonWeeks: int('CLASS_SESSION_HORIZON_WEEKS', 4), // seanslar necha hafta oldindan yaratiladi
    // Fayllar
    fileMaxImageBytes: int('FILE_MAX_IMAGE_BYTES', 10 * 1024 * 1024),
    fileMaxProofBytes: int('FILE_MAX_PROOF_BYTES', 5 * 1024 * 1024),
    fileMaxPdfBytes: int('FILE_MAX_PDF_BYTES', 50 * 1024 * 1024),
    fileUserQuotaBytes: int('FILE_USER_QUOTA_BYTES', 500 * 1024 * 1024),
    fileChunkBytes: 1024 * 1024,
    // Sinf fayllari (R5): PDF taqdimot kutubxonasi
    classFileMaxBytes: int('FILE_MAX_BYTES', 500 * 1024 * 1024), // bitta sinf PDF'i, standart 500 MiB (DIQQAT: yig'ish hozircha xotirada, KNOWN_GAPS)
    teacherStorageQuotaBytes: int('TEACHER_STORAGE_QUOTA_BYTES', 20 * 1024 * 1024 * 1024), // o'qituvchi uchun umumiy kvota; admin alohida oshira oladi
    diskMinFreeBytes: int('DISK_MIN_FREE_BYTES', 1024 * 1024 * 1024), // diskda shundan kam bo'sh joy qolsa yangi yuklashlar rad etiladi
    pdfMaxPages: int('PDF_MAX_PAGES', 600), // bitta PDF dagi sahifalar chegarasi
    pdfRenderTimeoutSec: int('PDF_RENDER_TIMEOUT_SEC', 300), // bitta fayl uchun umumiy vaqt chegarasi
    pdfFullWidth: int('PDF_FULL_WIDTH', 1000), // asosiy sahifa rasmi kengligi (px)
    pdfSmallWidth: int('PDF_SMALL_WIDTH', 600), // sust tarmoq uchun kichik rasm
    pdfThumbWidth: int('PDF_THUMB_WIDTH', 200), // eskiz
    uploadUrlTtlSeconds: int('FILE_UPLOAD_URL_TTL_SECONDS', 900),
    downloadUrlTtlSeconds: int('FILE_DOWNLOAD_URL_TTL_SECONDS', 120),
    pendingUploadMaxAgeHours: int('FILE_PENDING_MAX_AGE_HOURS', 24),
    // true bo'lsa va skaner sozlanmagan/xato bersa fayl KARANTINga tushadi (fail closed)
    fileScanRequired: process.env.FILE_SCAN_REQUIRED === 'true',
    reviewWindowDays: int('REVIEW_WINDOW_DAYS', 30),
    reviewEditHours: int('REVIEW_EDIT_HOURS', 48),
    // Reyting (Bayes): yangi o'qituvchi o'rtacha bahodan boshlaydi, ko'p baho kamdan-kam bahodan ustun
    ratingPriorMean: Number(process.env.RATING_PRIOR_MEAN) || 4.2,
    ratingPriorWeight: Number(process.env.RATING_PRIOR_WEIGHT) || 5,
    // Komissiya (bazis punkt: 1500 = 15%)
    commissionBps: int('PLATFORM_COMMISSION_BPS', 1500),
    holdHours: int('PAYMENT_HOLD_HOURS', 24), // dars tugagach pul shuncha soat "ushlab turiladi" (nizo oynasi)
    minPayoutMinor: int('MIN_PAYOUT_MINOR', 5_000_000), // 50 000 so'm
    paymentRequiredForCalls: process.env.PAYMENT_REQUIRED_FOR_CALLS === 'true',
    // School17 BEPUL: platforma pul ushlamaydi. Eski to'lov/daftar kodi (S8) o'chirilmagan, lekin ESCROW_ENABLED=true bo'lmasa ISHLAMAYDI.
    escrowEnabled: process.env.ESCROW_ENABLED === 'true',
  };
}
