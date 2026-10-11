import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { BookingStatus } from '@prisma/client';
import { IsDateString, IsInt, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Actor } from '../common/actor';
import { CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { BookingService } from './booking.service';

class CreateBookingDto {
  @IsUUID() teacherId!: string;
  @IsDateString() startAt!: string;
  @IsInt() durationMin!: number;
  @IsOptional() @IsUUID() studentId?: string;
}
class ReasonDto {
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}
class RescheduleDto {
  @IsDateString() startAt!: string;
}

function date(s: string | undefined, name: string): Date {
  const d = new Date(s ?? '');
  if (!s || Number.isNaN(d.getTime())) throw new BadRequestException(`Invalid ${name}`);
  return d;
}

@Controller()
@UseGuards(UserActorGuard)
export class BookingController {
  constructor(private bookings: BookingService) {}

  @Get('teachers/:id/slots') @RequirePermission('booking.participate')
  slots(@Param('id', ParseUUIDPipe) id: string, @Query('from') from: string, @Query('to') to: string, @Query('duration') duration = '60') {
    return this.bookings.slots(id, date(from, 'from'), date(to, 'to'), Number(duration));
  }

  @Post('bookings') @RequirePermission('booking.create')
  create(@CurrentActor() a: Actor, @Body() dto: CreateBookingDto) {
    return this.bookings.create(a, { teacherId: dto.teacherId, startAt: new Date(dto.startAt), durationMin: dto.durationMin, studentId: dto.studentId });
  }

  @Get('bookings') @RequirePermission('booking.participate')
  list(@CurrentActor() a: Actor, @Query('from') from: string, @Query('to') to: string, @Query('status') status?: string) {
    const statuses = status ? status.split(',').filter((s): s is BookingStatus => s in BookingStatus) : undefined;
    return this.bookings.list(a, date(from, 'from'), date(to, 'to'), statuses);
  }

  @Get('bookings/:id') @RequirePermission('booking.participate')
  get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.bookings.get(a, id); }

  @Post('bookings/:id/accept') @HttpCode(200) @RequirePermission('booking.participate')
  accept(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.bookings.accept(a, id); }

  @Post('bookings/:id/decline') @HttpCode(200) @RequirePermission('booking.participate')
  decline(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) { return this.bookings.decline(a, id, dto.reason); }

  @Post('bookings/:id/cancel') @HttpCode(200) @RequirePermission('booking.participate')
  cancel(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) { return this.bookings.cancel(a, id, dto.reason); }

  @Post('bookings/:id/reschedule') @HttpCode(200) @RequirePermission('booking.participate')
  reschedule(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RescheduleDto) {
    return this.bookings.proposeReschedule(a, id, new Date(dto.startAt));
  }

  @Post('bookings/:id/counter-offer') @HttpCode(200) @RequirePermission('booking.participate')
  counterOffer(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RescheduleDto) {
    return this.bookings.counterOffer(a, id, new Date(dto.startAt));
  }

  @Post('bookings/:id/reschedule/accept') @HttpCode(200) @RequirePermission('booking.participate')
  acceptReschedule(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.bookings.respondReschedule(a, id, true); }

  @Post('bookings/:id/reschedule/reject') @HttpCode(200) @RequirePermission('booking.participate')
  rejectReschedule(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.bookings.respondReschedule(a, id, false); }

  @Post('bookings/:id/no-show') @HttpCode(200) @RequirePermission('booking.participate')
  noShow(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.bookings.reportNoShow(a, id); }
}
