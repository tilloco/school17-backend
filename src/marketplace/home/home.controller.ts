import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { IsOptional, IsUUID } from 'class-validator';
import { Actor } from '../common/actor';
import { CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { HomeService } from './home.service';
import { ProgressService } from './progress.service';
import { StudentsService } from './students.service';
import { ClassChannelService } from '../classes/class-channel.service';
import { MessagingService } from '../messaging/messaging.service';

class LearningQuery {
  @IsOptional() @IsUUID() studentId?: string;
}

@Controller()
@UseGuards(UserActorGuard)
export class HomeController {
  constructor(private home: HomeService, private progress: ProgressService, private students: StudentsService, private channels: ClassChannelService, private messaging: MessagingService) {}

  /** Bosh ekran: rolga qarab kun tartibi, hisoblagichlar, to'lov/uy vazifasi holati */
  @Get('me/home') @RequirePermission('account.read.self')
  getHome(@CurrentActor() a: Actor) { return this.home.home(a); }

  /** Pupil progress for the Home screen: streak, weekly goal, class rank. */
  @Get('me/progress') @RequirePermission('account.read.self')
  getProgress(@CurrentActor() a: Actor) { return this.progress.mine(a); }

  /** Yangi xabarlar: shaxsiy suhbatlar + sinf kanallari (haqiqiy hisob, qo'lda yozilmagan). */
  @Get('me/unread') @RequirePermission('account.read.self')
  async unread(@CurrentActor() a: Actor) {
    const [messages, byClass] = await Promise.all([this.messaging.unreadTotal(a), this.channels.unreadByClass(a)]);
    const channels = Object.values(byClass).reduce((x, y) => x + y, 0);
    return { messages, channels, byClass, total: messages + channels };
  }

  /** O'quvchi/vasiy: sinflarim, kelgusi darslar, tarix va statistika */
  @Get('me/learning') @RequirePermission('class.read')
  learning(@CurrentActor() a: Actor, @Query() q: LearningQuery) { return this.home.learning(a, q.studentId); }

  @Get('teachers/me/students') @RequirePermission('teacher.profile.manage')
  list(@CurrentActor() a: Actor) { return this.students.list(a); }

  @Get('teachers/me/find-students') @RequirePermission('teacher.profile.manage')
  find(@CurrentActor() a: Actor, @Query('q') q?: string) { return this.students.findPupils(a, q ?? ''); }

  @Get('teachers/me/students/:pupilId') @RequirePermission('teacher.profile.manage')
  detail(@CurrentActor() a: Actor, @Param('pupilId', ParseUUIDPipe) id: string) { return this.students.detail(a, id); }
}
