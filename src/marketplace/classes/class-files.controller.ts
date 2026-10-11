import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ReportReason } from '@prisma/client';
import { IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Actor } from '../common/actor';
import { AdminActorGuard, CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { ClassFilesService, PageSize } from './class-files.service';

class AddFileDto { @IsUUID() fileId!: string; @IsOptional() @IsBoolean() allowDownload?: boolean; }
class DownloadDto { @IsBoolean() allowDownload!: boolean; }
class StrokesDto { @IsArray() strokes!: unknown[]; }
class ReportFileDto { @IsEnum(ReportReason) reason!: ReportReason; @IsOptional() @IsString() @MaxLength(1000) note?: string; }
class PresentDto { @IsOptional() @IsUUID() fileId?: string; @IsOptional() @IsInt() @Min(1) @Max(10000) page?: number; }
class TakedownDto { @IsOptional() @IsString() @MaxLength(300) reason?: string; }
class QuotaDto { @IsOptional() @IsInt() @Min(0) @Max(10_000_000) mb?: number | null; }

@Controller('classes/:id/files')
@UseGuards(UserActorGuard)
export class ClassFilesController {
  constructor(private files: ClassFilesService) {}

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post() @HttpCode(201) @RequirePermission('class.manage')
  add(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddFileDto) { return this.files.add(a, id, dto.fileId, dto.allowDownload); }

  @Get() @RequirePermission('class.read')
  list(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Query('q') q?: string) { return this.files.list(a, id, q); }

  @Patch(':fid') @RequirePermission('class.manage')
  patch(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Param('fid', ParseUUIDPipe) fid: string, @Body() dto: DownloadDto) { return this.files.setDownload(a, id, fid, dto.allowDownload); }

  @Delete(':fid') @RequirePermission('class.manage')
  remove(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Param('fid', ParseUUIDPipe) fid: string) { return this.files.remove(a, id, fid); }

  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @Get(':fid/pages/:n') @RequirePermission('class.read')
  async page(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Param('fid', ParseUUIDPipe) fid: string, @Param('n', ParseIntPipe) n: number, @Query('size') size: string | undefined, @Res() res: any) {
    const s: PageSize = size === 'small' || size === 'thumb' ? size : 'full';
    const buf = await this.files.page(a, id, fid, n, s);
    res.set({ 'content-type': 'image/webp', 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" });
    res.send(buf);
  }

  @Get(':fid/pages/:n/annotations') @RequirePermission('class.read')
  annotations(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Param('fid', ParseUUIDPipe) fid: string, @Param('n', ParseIntPipe) n: number) { return this.files.getAnnotations(a, id, fid, n); }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Put(':fid/pages/:n/annotations') @RequirePermission('class.manage')
  putAnnotations(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Param('fid', ParseUUIDPipe) fid: string, @Param('n', ParseIntPipe) n: number, @Body() dto: StrokesDto) { return this.files.putAnnotations(a, id, fid, n, dto.strokes); }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post(':fid/download-url') @HttpCode(200) @RequirePermission('class.read')
  downloadUrl(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Param('fid', ParseUUIDPipe) fid: string) { return this.files.downloadUrl(a, id, fid); }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':fid/report') @HttpCode(201) @RequirePermission('report.create')
  report(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Param('fid', ParseUUIDPipe) fid: string, @Body() dto: ReportFileDto) { return this.files.report(a, id, fid, dto.reason, dto.note); }
}

@Controller('class-sessions/:sid/present')
@UseGuards(UserActorGuard)
export class ClassPresentController {
  constructor(private files: ClassFilesService) {}

  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post() @HttpCode(200) @RequirePermission('class.manage')
  present(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string, @Body() dto: PresentDto) { return this.files.present(a, sid, dto.fileId ?? null, dto.page ?? 1); }

  @Post('stop') @HttpCode(200) @RequirePermission('class.manage')
  stop(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string) { return this.files.present(a, sid, null, 1); }
}

@Controller('admin/market')
@UseGuards(AdminActorGuard)
export class ClassFilesAdminController {
  constructor(private files: ClassFilesService) {}

  @Post('class-files/:id/takedown') @HttpCode(200) @RequirePermission('moderation.review')
  takedown(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TakedownDto) { return this.files.takedown(a, id, dto.reason); }

  @Post('class-files/:id/restore') @HttpCode(200) @RequirePermission('moderation.review')
  restore(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.files.restore(a, id); }

  @Get('storage') @RequirePermission('moderation.review')
  storage() { return this.files.storage_(); }

  @Post('teachers/:id/storage-quota') @HttpCode(200) @RequirePermission('moderation.review')
  quota(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: QuotaDto) { return this.files.setTeacherQuota(a, id, dto.mb ?? null); }
}
