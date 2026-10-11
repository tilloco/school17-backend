import { Global, Module } from '@nestjs/common';
import { AuditService } from './common/audit.service';
import { AccountService } from './account/account.service';
import { AccountController, AuditController } from './account/account.controller';
import { AdminActorGuard, UserActorGuard } from './common/actor.guard';
import { TeachersService } from './teachers/teachers.service';
import { TeachersAdminController, TeachersMeController, TeachersPublicController } from './teachers/teachers.controller';
import { ClockService } from './common/clock';
import { GuardianService } from './guardian/guardian.service';
import { NotificationsService } from './notifications/notifications.service';
import { BookingService } from './booking/booking.service';
import { BookingController } from './booking/booking.controller';
import { DomainEvents } from './common/events';
import { CALL_PROVIDER } from './calls/call-provider';
import { createCallProvider } from './calls/call-provider.factory';
import { CallsService } from './calls/calls.service';
import { CallsAdminController, CallsController, CallsWebhookController } from './calls/calls.controller';

@Global()
@Module({
  // Tartib muhim: 'teachers/me' controller'i 'teachers/:id' dan oldin turishi kerak
  controllers: [AccountController, AuditController, TeachersMeController, TeachersPublicController, TeachersAdminController, BookingController, CallsController, CallsWebhookController, CallsAdminController],
  providers: [DomainEvents, { provide: CALL_PROVIDER, useFactory: () => createCallProvider() }, CallsService, ClockService, GuardianService, NotificationsService, BookingService, AuditService, AccountService, TeachersService, UserActorGuard, AdminActorGuard],
  exports: [DomainEvents, CALL_PROVIDER, CallsService, ClockService, GuardianService, NotificationsService, BookingService, AuditService, AccountService, TeachersService],
})
export class MarketplaceModule {}
