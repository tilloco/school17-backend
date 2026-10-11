import { Global, Module } from '@nestjs/common';
import { AuditService } from './common/audit.service';
import { AccountService } from './account/account.service';
import { AccountController, AuditController } from './account/account.controller';
import { AdminActorGuard, UserActorGuard } from './common/actor.guard';

@Global()
@Module({
  controllers: [AccountController, AuditController],
  providers: [AuditService, AccountService, UserActorGuard, AdminActorGuard],
  exports: [AuditService, AccountService],
})
export class MarketplaceModule {}
