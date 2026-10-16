import { Body, Controller, Get, HttpCode, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Actor } from '../common/actor';
import { AdminActorGuard, CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { AccountService } from './account.service';
import { PrivacyService } from '../privacy/privacy.service';
import { Equals } from 'class-validator';

class DeleteDto {
  @Equals('DELETE') confirm!: string;
}

class UpdateMeDto {
  @IsOptional() @IsString() @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(24) username?: string;
  @IsOptional() @IsString() @MaxLength(5) locale?: string;
  @IsOptional() @IsString() @MaxLength(64) timezone?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) dateOfBirth?: string;
}

class SwitchRoleDto {
  @IsIn([Role.TEACHER, Role.GUARDIAN]) role!: Role;
}

@Controller('me')
@UseGuards(UserActorGuard)
export class AccountController {
  constructor(private account: AccountService, private privacy: PrivacyService) {}

  @Post('delete') @HttpCode(200) @RequirePermission('account.delete.self')
  del(@CurrentActor() actor: Actor, @Body() _dto: DeleteDto) { return this.privacy.deleteAccount(actor); }

  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
  @Get('export') @RequirePermission('account.read.self')
  export(@CurrentActor() actor: Actor) { return this.privacy.exportData(actor); }

  @Get()
  @RequirePermission('account.read.self')
  me(@CurrentActor() actor: Actor) {
    return this.account.me(actor);
  }

  @Patch()
  @RequirePermission('account.read.self')
  update(@CurrentActor() actor: Actor, @Body() dto: UpdateMeDto) {
    return this.account.update(actor, dto);
  }

  @Post('role')
  @RequirePermission('account.read.self')
  switchRole(@CurrentActor() actor: Actor, @Body() dto: SwitchRoleDto) {
    return this.account.switchRole(actor, dto.role);
  }
}

@Controller('admin/market/audit')
@UseGuards(AdminActorGuard)
export class AuditController {
  constructor(private account: AccountService) {}

  @Get()
  @RequirePermission('audit.read')
  list(@Query('skip') skip = '0', @Query('take') take = '50', @Query('action') action?: string) {
    return this.account.listAudit(Math.max(0, Number(skip) || 0), Number(take) || 50, action);
  }
}
