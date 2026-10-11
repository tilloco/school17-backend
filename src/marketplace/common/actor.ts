import { Role } from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';
import { Permission, roleHas } from './permissions';

export interface Actor {
  kind: 'user' | 'admin';
  id: string;
  role: Role;
  /** 18 yoshdan kichik (tug'ilgan sana ma'lum bo'lsa). Sana noma'lum bo'lsa isMinor=false, ageKnown=false. */
  isMinor: boolean;
  ageKnown: boolean;
  timezone: string;
  locale: string;
}

export function can(actor: Actor, permission: Permission): boolean {
  return roleHas(actor.role, permission);
}

export function requirePermission(actor: Actor, permission: Permission): void {
  if (!can(actor, permission)) {
    throw new ForbiddenException('Forbidden');
  }
}

export function ageInYears(dob: Date, now: Date): number {
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

export const ADULT_AGE = 18;
// NEEDS LAWYER: minimal akkaunt yoshi (13 taxminiy) O'zbekiston qonunchiligi bo'yicha tasdiqlanishi kerak.
export const MIN_ACCOUNT_AGE = 13;
