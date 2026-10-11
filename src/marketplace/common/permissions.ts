import { Role } from '@prisma/client';

// Har bir amal uchun alohida ruxsat nomi. Yangi route qo'shilganda shu ro'yxatga
// qo'shiladi va @RequirePermission() bilan ulanadi. Rol -> ruxsat jadvali bitta joyda.
export const PERMISSIONS = [
  'account.read.self',
  'account.delete.self',
  'teacher.profile.manage',
  'teacher.verification.review',
  'teacher.availability.manage',
  'booking.create',
  'booking.participate',
  'call.join',
  'message.send',
  'review.create',
  'review.reply',
  'earnings.view',
  'payout.request',
  'payout.review',
  'payment.pay',
  'payment.review',
  'directpay.mark',
  'directpay.confirm',
  'report.create',
  'moderation.review',
  'audit.read',
  'guardian.manage',
  'class.manage',
  'class.join',
  'class.read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL_USERS: Permission[] = ['account.read.self', 'account.delete.self', 'report.create', 'message.send'];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  STUDENT: new Set<Permission>([...ALL_USERS, 'booking.create', 'booking.participate', 'call.join', 'review.create', 'payment.pay', 'directpay.mark', 'class.join', 'class.read']),
  GUARDIAN: new Set<Permission>([
    ...ALL_USERS,
    'booking.create',
    'booking.participate',
    'call.join',
    'review.create',
    'payment.pay',
    'directpay.mark',
    'guardian.manage',
    'class.join',
    'class.read',
  ]),
  TEACHER: new Set<Permission>([
    ...ALL_USERS,
    'teacher.profile.manage',
    'teacher.availability.manage',
    'booking.participate',
    'call.join',
    'review.reply',
    'directpay.confirm',
    'class.manage',
    'class.read',
    'earnings.view',
    'payout.request',
  ]),
  // Admin foydalanuvchi sifatida dars o'tmaydi/sotib olmaydi; faqat boshqaruv ruxsatlari.
  ADMIN: new Set<Permission>([
    'account.read.self',
    'teacher.verification.review',
    'payout.review',
    'payment.review',
    'moderation.review',
    'audit.read',
    'report.create',
  ]),
};

export function roleHas(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}
