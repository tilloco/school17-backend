import { DirectPaymentStatus } from '@prisma/client';

// To'g'ridan-to'g'ri to'lov belgilari holat mashinasi (sof mantiq). Ilova pul ushlamaydi: bu faqat "belgi".
export type DirectEvent = 'pupil_paid' | 'teacher_received' | 'teacher_not_received' | 'teacher_waive' | 'system_waive';

export const FROM: Record<DirectEvent, DirectPaymentStatus[]> = {
  pupil_paid: ['UNPAID', 'NOT_RECEIVED'], // "Not received" dan keyin o'quvchi qayta belgilashi mumkin
  teacher_received: ['UNPAID', 'PUPIL_MARKED_PAID', 'NOT_RECEIVED'],
  teacher_not_received: ['PUPIL_MARKED_PAID'],
  teacher_waive: ['UNPAID', 'PUPIL_MARKED_PAID', 'NOT_RECEIVED'],
  // Bekor qilingan / o'qituvchi kelmagan / texnik muammo: TEACHER_CONFIRMED tegilmaydi (o'qituvchi pul olganini aytgan)
  system_waive: ['UNPAID', 'PUPIL_MARKED_PAID', 'NOT_RECEIVED'],
};

const TO: Record<DirectEvent, DirectPaymentStatus> = {
  pupil_paid: 'PUPIL_MARKED_PAID',
  teacher_received: 'TEACHER_CONFIRMED',
  teacher_not_received: 'NOT_RECEIVED',
  teacher_waive: 'WAIVED',
  system_waive: 'WAIVED',
};

export function nextDirectStatus(from: DirectPaymentStatus, event: DirectEvent): DirectPaymentStatus | null {
  return FROM[event].includes(from) ? TO[event] : null;
}

/** To'lov belgisi qo'yiladigan bron holatlari (qabul qilingan va o'quvchi to'lashi kerak bo'lgan darslar). */
export const PAYABLE_BOOKING_STATUSES = ['CONFIRMED', 'COMPLETED', 'NO_SHOW_STUDENT'] as const;
