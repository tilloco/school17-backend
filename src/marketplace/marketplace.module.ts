import { Global, Module } from '@nestjs/common';
import { AuditService } from './common/audit.service';
import { AccountService } from './account/account.service';
import { AccountController, AuditController } from './account/account.controller';
import { AdminActorGuard, UserActorGuard } from './common/actor.guard';
import { TeachersService } from './teachers/teachers.service';
import { TeachersAdminController, TeachersMeController, TeachersPublicController } from './teachers/teachers.controller';

@Global()
@Module({
  // Tartib muhim: 'teachers/me' controller'i 'teachers/:id' dan oldin turishi kerak
  controllers: [AccountController, AuditController, TeachersMeController, TeachersPublicController, TeachersAdminController],
  providers: [AuditService, AccountService, TeachersService, UserActorGuard, AdminActorGuard],
  exports: [AuditService, AccountService, TeachersService],
})
export class MarketplaceModule {}
