import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { join } from 'path';
import { FilesService } from './files/files.service';
import { FilesAdminController, FilesController, FilesStorageController } from './files/files.controller';
import { LocalDiskStorage, OBJECT_STORAGE } from './files/storage';
import { createScanProvider, SCAN_PROVIDER } from './files/scanner';
import { DiscoveryService } from './discovery/discovery.service';
import { DiscoveryController } from './discovery/discovery.controller';
import { ReviewsService } from './reviews/reviews.service';
import { ModerationAdminController, ReviewsController } from './reviews/reviews.controller';
import { ReportsService } from './moderation/reports.service';
import { LedgerService } from './payments/ledger.service';
import { PaymentsService } from './payments/payments.service';
import { PaymentsAdminController, PaymentsController } from './payments/payments.controller';
import { createPaymentProvider, PAYMENT_PROVIDER } from './payments/payment-provider';
import { BlocksService } from './safety/blocks.service';
import { LegalService } from './legal/legal.service';
import { BlocksController, ConsentsController, GuardianController, PublicLegalController } from './safety/safety.controller';
import { PrivacyService } from './privacy/privacy.service';
import { NotificationDispatcher, PUSH_SENDER, createPushSender } from './notifications/dispatcher.service';
import { NotificationsController } from './notifications/notifications.controller';
import { PaymentInfoService } from './teachers/payment-info.service';
import { PaymentInfoMeController, PaymentInfoRevealController } from './teachers/payment-info.controller';
import { ClassesService } from './classes/classes.service';
import { ClassesController } from './classes/classes.controller';
import { ClassRoomService } from './classes/class-room.service';
import { ClassRoomController } from './classes/class-room.controller';
import { ClassFilesService } from './classes/class-files.service';
import { ClassFilesController, ClassPresentController, ClassFilesAdminController } from './classes/class-files.controller';
import { PDF_RENDERER, createPdfRenderer } from './files/pdf-renderer';
import { ClassBoardService } from './classes/class-board.service';
import { ClassBoardController } from './classes/class-board.controller';
import { ClassPaymentsService } from './classes/class-payments.service';
import { ClassPaymentsController } from './classes/class-payments.controller';
import { ClassFeedService } from './classes/class-feed.service';
import { ClassFeedController } from './classes/class-feed.controller';
import { ClassRemindersService } from './classes/class-reminders.service';
import { ClassPollService } from './classes/class-poll.service';
import { ClassPollController } from './classes/class-poll.controller';
import { HomeService } from './home/home.service';
import { ProgressService } from './home/progress.service';
import { TopicsAdminController, TopicsController } from './topics/topics.controller';
import { ShareController } from './topics/share.controller';
import { LegalPagesController } from './legal/legal-pages.controller';
import { TopicsService } from './topics/topics.service';
import { StudentsService } from './home/students.service';
import { HomeController } from './home/home.controller';
import { NetCheckController } from './classes/netcheck.controller';
import { ClassChatService } from './classes/class-chat.service';
import { ClassChatController } from './classes/class-chat.controller';
import { DirectService } from './messaging/direct.service';
import { AvatarsService } from './account/avatars.service';
import { AvatarsController } from './account/avatars.controller';
import { CommentsService } from './reviews/comments.service';
import { CommentsController } from './reviews/comments.controller';
import { ClassRankingService } from './classes/class-ranking.service';
import { ClassRankingController } from './classes/class-ranking.controller';
import { ClassChannelService } from './classes/class-channel.service';
import { ClassChannelController } from './classes/class-channel.controller';
import { DirectPaymentService } from './direct-payment/direct-payment.service';
import { DirectPaymentController, MyDirectPaymentsController, TeacherMoneyController } from './direct-payment/direct-payment.controller';
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
  controllers: [HomeController, ClassPollController, ClassFeedController, ClassPaymentsController, ClassBoardController, ClassFilesController, ClassPresentController, ClassFilesAdminController, NetCheckController, ClassesController, ClassRoomController, ClassChatController, ClassChannelController, ClassRankingController, CommentsController, AvatarsController, DirectPaymentController, TeacherMoneyController, MyDirectPaymentsController, PaymentInfoMeController, PaymentInfoRevealController, NotificationsController, GuardianController, BlocksController, ConsentsController, PublicLegalController, AccountController, AuditController, DiscoveryController, ReviewsController, ModerationAdminController, PaymentsController, PaymentsAdminController, TeachersMeController, TeachersPublicController, TeachersAdminController, BookingController, CallsController, CallsWebhookController, CallsAdminController, MessagingController, FilesController, FilesStorageController, FilesAdminController, TopicsController, TopicsAdminController, ShareController, LegalPagesController],
  providers: [
    ClassesService,
    ClassRoomService,
    ClassChatService,
    ClassChannelService,
    ClassRankingService,
    CommentsService,
    DirectService,
    AvatarsService,
    ClassFilesService,
    ClassBoardService,
    ClassPaymentsService,
    ClassFeedService,
    ClassPollService,
    HomeService,
    ProgressService,
    TopicsService,
    StudentsService,
    ClassRemindersService,
    { provide: PDF_RENDERER, useFactory: () => createPdfRenderer() },
    DirectPaymentService,
    PaymentInfoService,
    NotificationDispatcher, { provide: PUSH_SENDER, useFactory: () => createPushSender() },
    PrivacyService,
    BlocksService, LegalService,
    LedgerService, PaymentsService, { provide: PAYMENT_PROVIDER, useFactory: () => createPaymentProvider() },
    ReviewsService, ReportsService, DiscoveryService, RealtimeService, MessagingGateway, MessagingService, FilesService,
    { provide: OBJECT_STORAGE, useFactory: () => new LocalDiskStorage(process.env.FILES_DIR || join(process.cwd(), 'uploads-private')) },
    { provide: SCAN_PROVIDER, useFactory: () => createScanProvider() },
    DomainEvents, { provide: CALL_PROVIDER, useFactory: () => createCallProvider() }, CallsService, ClockService, GuardianService, NotificationsService, BookingService, AuditService, AccountService, TeachersService, UserActorGuard, AdminActorGuard],
  exports: [DirectPaymentService, PaymentInfoService, NotificationDispatcher, PUSH_SENDER, BlocksService, LegalService, LedgerService, PaymentsService, PAYMENT_PROVIDER, ReviewsService, ReportsService, FilesService, MessagingService, RealtimeService, DomainEvents, CALL_PROVIDER, CallsService, ClockService, GuardianService, NotificationsService, BookingService, AuditService, AccountService, TeachersService],
})
export class MarketplaceModule {}
