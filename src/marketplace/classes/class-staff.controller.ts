import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { Actor } from '../common/actor';
import { CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { FilesService } from '../files/files.service';
import { ClassPaymentsService } from './class-payments.service';
import { ClassRequestsService } from './class-requests.service';
import { ClassStaffService } from './class-staff.service';

class HelperDto {
  @IsString() @MaxLength(40) username!: string;
  @IsOptional() @IsBoolean() canPayments?: boolean;
  @IsOptional() @IsBoolean() canMembers?: boolean;
  @IsOptional() @IsBoolean() canChat?: boolean;
}
class IdsDto { @IsString({ each: true }) ids!: string[]; }

/** Helpers, join requests and what a helper may do. Its own path prefix so it never competes with "classes/:id". */
@Controller('class-staff')
@UseGuards(UserActorGuard)
export class ClassStaffController {
  constructor(private staff: ClassStaffService, private requests: ClassRequestsService, private payments: ClassPaymentsService, private files: FilesService) {}

  @Get('mine') @RequirePermission('class.read')
  mine(@CurrentActor() a: Actor) { return this.staff.helping(a); }

  @Get('my-requests') @RequirePermission('class.read')
  myRequests(@CurrentActor() a: Actor) { return this.requests.myRequests(a); }

  // ---- the teacher names helpers ----
  @Get(':id/helpers') @RequirePermission('class.manage')
  helpers(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.staff.helpers(a, id); }

  @Post(':id/helpers') @HttpCode(201) @RequirePermission('class.manage')
  add(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: HelperDto) { return this.staff.addHelper(a, id, dto.username, dto); }

  @Delete(':id/helpers/:uid') @RequirePermission('class.manage')
  remove(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Param('uid', ParseUUIDPipe) uid: string) { return this.staff.removeHelper(a, id, uid); }

  // ---- join requests (teacher or a helper who may approve members) ----
  @Get(':id/requests') @RequirePermission('class.read')
  list(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.requests.list(a, id); }

  @Post(':id/requests/:eid/approve') @HttpCode(200) @RequirePermission('class.read')
  approve(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Param('eid', ParseUUIDPipe) eid: string) { return this.requests.decide(a, id, eid, true); }

  @Post(':id/requests/:eid/decline') @HttpCode(200) @RequirePermission('class.read')
  decline(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Param('eid', ParseUUIDPipe) eid: string) { return this.requests.decide(a, id, eid, false); }

  @Get(':id/requests/:eid/proof') @RequirePermission('class.read')
  async proof(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Param('eid', ParseUUIDPipe) eid: string, @Res() res: any) {
    const f = await this.requests.proofFile(a, id, eid);
    const data = await this.files.readThumb(f);
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Content-Disposition', 'attachment; filename="proof.webp"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).end(data);
  }

  // ---- payments (teacher or a helper who may check payments) ----
  @Get(':id/money') @RequirePermission('class.read')
  money(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Query('period') period?: string) { return this.payments.board(a, id, period); }

  @Post(':id/money/received') @HttpCode(200) @RequirePermission('class.read')
  received(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: IdsDto) { return this.payments.markReceived(a, id, dto.ids); }

  @Post(':id/money/not-received') @HttpCode(200) @RequirePermission('class.read')
  notReceived(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: IdsDto) { return this.payments.markNotReceived(a, id, dto.ids); }
}
