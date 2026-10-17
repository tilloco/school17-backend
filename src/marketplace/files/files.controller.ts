import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { StoredFilePurpose } from '@prisma/client';
import { IsEnum, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Actor } from '../common/actor';
import { AdminActorGuard, CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { FilesService } from './files.service';

class InitDto {
  @IsEnum(StoredFilePurpose) purpose!: StoredFilePurpose;
  @IsString() @MaxLength(200) name!: string;
  @IsInt() @Min(1) @Max(2 ** 50) size!: number;
  @IsString() @MaxLength(100) mime!: string;
}
class DownloadDto {
  @IsOptional() @IsIn(['original', 'thumb']) variant?: 'original' | 'thumb';
}

@Controller('files')
@UseGuards(UserActorGuard)
export class FilesController {
  constructor(private files: FilesService) {}

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('init') @HttpCode(201) @RequirePermission('account.read.self')
  init(@CurrentActor() a: Actor, @Body() dto: InitDto) { return this.files.init(a, dto); }

  // 'quota' ":id" dan OLDIN bo'lishi shart
  @Get('quota') @RequirePermission('account.read.self')
  quota(@CurrentActor() a: Actor) { return this.files.quota(a); }

  @Get(':id') @RequirePermission('account.read.self')
  get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.files.get(a, id); }

  @Post(':id/resume') @HttpCode(200) @RequirePermission('account.read.self')
  resume(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.files.resume(a, id); }

  @Post(':id/complete') @HttpCode(200) @RequirePermission('account.read.self')
  complete(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.files.complete(a, id); }

  @Post(':id/cancel') @HttpCode(200) @RequirePermission('account.read.self')
  cancel(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.files.cancel(a, id); }

  @Delete(':id') @RequirePermission('account.read.self')
  remove(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.files.remove(a, id); }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post(':id/download-url') @HttpCode(200) @RequirePermission('account.read.self')
  downloadUrl(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DownloadDto) {
    return this.files.downloadUrl(a, id, dto.variant ?? 'original');
  }
}

/** "Saqlash" tomoni: autentifikatsiya = server bergan imzolangan URL (S3 presigned URL kabi). Bearer token KERAK EMAS. */
@Controller('files')
export class FilesStorageController {
  constructor(private files: FilesService) {}

  @Put('upload/:fileId/:index')
  async put(
    @Param('fileId', ParseUUIDPipe) fileId: string,
    @Param('index', ParseIntPipe) index: number,
    @Query('uid') uid: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Req() req: any,
  ) {
    if (!Buffer.isBuffer(req.body)) throw new BadRequestException('Raw body required');
    return this.files.putChunk(fileId, index, uid, Number(exp), sig, req.body);
  }

  @Get('blob/:fileId/:variant')
  async blob(
    @Param('fileId', ParseUUIDPipe) fileId: string,
    @Param('variant') variant: string,
    @Query('uid') uid: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Req() req: any,
    @Res() res: any,
  ) {
    const f = await this.files.serve(fileId, variant, uid, Number(exp), sig);
    // Foydalanuvchi fayllari HECH QACHON ilovaning o'z originida inline ko'rsatilmaydi:
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Accept-Ranges', 'bytes');
    if ('data' in f && f.data) {
      res.setHeader('Content-Length', String(f.data.length));
      res.status(200).end(f.data);
      return;
    }
    // Katta fayllar: oqim va Range (video ko'rish, yuklashni davom ettirish)
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    let start = 0;
    let end = f.size - 1;
    if (m && (m[1] || m[2])) {
      if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); }
      else { start = Math.max(0, f.size - Number(m[2])); }
      if (start > end || start >= f.size) { res.setHeader('Content-Range', `bytes */${f.size}`); res.status(416).end(); return; }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${f.size}`);
    } else {
      res.status(200);
    }
    res.setHeader('Content-Length', String(end - start + 1));
    const rs = this.files.stream(f.key!, { start, end });
    rs.on('error', () => res.destroy());
    res.on('close', () => (rs as any).destroy?.());
    rs.pipe(res);
  }
}

@Controller('admin/market/files')
@UseGuards(AdminActorGuard)
export class FilesAdminController {
  constructor(private files: FilesService) {}

  /** Hujjatlarni tekshirish uchun (faqat tasdiqlash huquqi bor admin); har chaqiruv audit jurnaliga yoziladi. */
  @Post(':id/download-url') @HttpCode(200) @RequirePermission('teacher.verification.review')
  url(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.files.downloadUrl(a, id, 'original', true); }
}
