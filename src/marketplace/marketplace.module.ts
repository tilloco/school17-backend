import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { join } from 'path';
import { FilesService } from './files/files.service';
import { FilesAdminController, FilesController, FilesStorageController } from './files/files.controller';
import { LocalDiskStorage, OBJECT_STORAGE } from './files/storage';
import { createScanProvider, SCAN_PROVIDER } from './files/scanner';
import { MessagingService } from './messaging/messaging.service';
import { MessagingController } from './messaging/messaging.controller';
import { MessagingGateway } from './messaging/messaging.gateway';
import { RealtimeService } from './messaging/realtime.service';
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
  imports: [
    JwtModule.registerAsync({ imports: [ConfigModule], inject: [ConfigService], useFactory: (c: ConfigService) => ({ secret: c.get<string>('JWT_SECRET') }) }),
  ],
  // Tartib muhim: 'teachers/me' controller'i 'teachers/:id' dan oldin turishi kerak
  controllers: [AccountController, AuditController, TeachersMeController, TeachersPublicController, TeachersAdminController, BookingController, CallsController, CallsWebhookController, CallsAdminController, MessagingController, FilesController, FilesStorageController, FilesAdminController],
  providers: [
    RealtimeService, MessagingGateway, MessagingService, FilesService,
    { provide: OBJECT_STORAGE, useFactory: () => new LocalDiskStorage(process.env.FILES_DIR || join(process.cwd(), 'uploads-private')) },
    { provide: SCAN_PROVIDER, useFactory: () => createScanProvider() },
    DomainEvents, { provide: CALL_PROVIDER, useFactory: () => createCallProvider() }, CallsService, ClockService, GuardianService, NotificationsService, BookingService, AuditService, AccountService, TeachersService, UserActorGuard, AdminActorGuard],
  exports: [FilesService, MessagingService, RealtimeService, DomainEvents, CALL_PROVIDER, CallsService, ClockService, GuardianService, NotificationsService, BookingService, AuditService, AccountService, TeachersService],
})
export class MarketplaceModule {}
