import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { AccountStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor, ADULT_AGE, ageInYears, can } from './actor';
import { Permission } from './permissions';

const PERMISSION_KEY = 'marketplace:permission';
export const RequirePermission = (p: Permission) => SetMetadata(PERMISSION_KEY, p);

export const CurrentActor = createParamDecorator((_d: unknown, ctx: ExecutionContext): Actor => {
  return ctx.switchToHttp().getRequest().actor;
});

class UserJwt extends AuthGuard('jwt') {}
class AdminJwt extends AuthGuard('admin-jwt') {}

function checkPermission(reflector: Reflector, ctx: ExecutionContext, actor: Actor): boolean {
  const p = reflector.getAllAndOverride<Permission | undefined>(PERMISSION_KEY, [ctx.getHandler(), ctx.getClass()]);
  if (p && !can(actor, p)) throw new ForbiddenException('Forbidden');
  return true;
}

/**
 * Foydalanuvchi tokenini tekshiradi, so'ng rol/holatni HAR SAFAR bazadan o'qiydi
 * (token ichidagi rolga ishonmaymiz: bloklangan yoki o'chirilgan akkaunt darhol to'xtaydi).
 * @RequirePermission() berilgan bo'lsa, ruxsatni ham tekshiradi.
 */
@Injectable()
export class UserActorGuard implements CanActivate {
  private jwt = new UserJwt();
  constructor(private prisma: PrismaService, private reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    await this.jwt.canActivate(ctx);
    const req = ctx.switchToHttp().getRequest();
    const user = await this.prisma.user.findUnique({ where: { id: req.user?.userId } });
    if (!user || user.status !== AccountStatus.ACTIVE) throw new UnauthorizedException('Unauthorized');
    const actor: Actor = {
      kind: 'user',
      id: user.id,
      role: user.role,
      ageKnown: !!user.dateOfBirth,
      isMinor: user.dateOfBirth ? ageInYears(user.dateOfBirth, new Date()) < ADULT_AGE : false,
      timezone: user.timezone,
      locale: user.locale,
    };
    req.actor = actor;
    return checkPermission(this.reflector, ctx, actor);
  }
}

/** Admin tokeni (alohida ADMIN_JWT_SECRET) orqali kirgan boshqaruvchi. */
@Injectable()
export class AdminActorGuard implements CanActivate {
  private jwt = new AdminJwt();
  constructor(private prisma: PrismaService, private reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    await this.jwt.canActivate(ctx);
    const req = ctx.switchToHttp().getRequest();
    const admin = await this.prisma.admin.findUnique({ where: { id: req.user?.adminId } });
    if (!admin) throw new UnauthorizedException('Unauthorized');
    const actor: Actor = {
      kind: 'admin',
      id: admin.id,
      role: 'ADMIN',
      ageKnown: true,
      isMinor: false,
      timezone: 'Asia/Tashkent',
      locale: 'uz',
    };
    req.actor = actor;
    return checkPermission(this.reflector, ctx, actor);
  }
}
