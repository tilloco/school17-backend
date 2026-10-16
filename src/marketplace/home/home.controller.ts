import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { IsOptional, IsUUID } from 'class-validator';
import { Actor } from '../common/actor';
import { CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { HomeService } from './home.service';
import { StudentsService } from './students.service';

class LearningQuery {
  @IsOptional() @IsUUID() studentId?: string;
}

@Controller()
@UseGuards(UserActorGuard)
export class HomeController {
  constructor(private home: HomeService, private students: StudentsService) {}

  /** Bosh ekran: rolga qarab kun tartibi, hisoblagichlar, to'lov/uy vazifasi holati */
  @Get('me/home') @RequirePermission('account.read.self')
  getHome(@CurrentActor() a: Actor) { return this.home.home(a); }

  /** O'quvchi/vasiy: sinflarim, kelgusi darslar, tarix va statistika */
  @Get('me/learning') @RequirePermission('class.read')
  learning(@CurrentActor() a: Actor, @Query() q: LearningQuery) { return this.home.learning(a, q.studentId); }

  @Get('teachers/me/students') @RequirePermission('teacher.profile.manage')
  list(@CurrentActor() a: Actor) { return this.students.list(a); }

  @Get('teachers/me/students/:pupilId') @RequirePermission('teacher.profile.manage')
  detail(@CurrentActor() a: Actor, @Param('pupilId', ParseUUIDPipe) id: string) { return this.students.detail(a, id); }
}
