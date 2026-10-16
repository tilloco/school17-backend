import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Put, Res, UseGuards } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import { Actor } from '../common/actor';
import { CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { FilesService } from '../files/files.service';
import { AvatarsService } from './avatars.service';

class AvatarDto { @IsUUID() fileId!: string; }

@Controller()
@UseGuards(UserActorGuard)
export class AvatarsController {
  constructor(private avatars: AvatarsService, private files: FilesService) {}

  @Put('me/avatar') @HttpCode(200) @RequirePermission('account.read.self')
  set(@CurrentActor() a: Actor, @Body() dto: AvatarDto) { return this.avatars.set(a, dto.fileId); }

  @Delete('me/avatar') @RequirePermission('account.read.self')
  remove(@CurrentActor() a: Actor) { return this.avatars.remove(a); }

  /** Kichik profil kartasi (guruhdagi odamni bosganda): ism, @nom, bio. */
  @Get('users/:id/card') @RequirePermission('account.read.self')
  card(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.avatars.card(a, id); }

  /** Rasm (eskiz). Mobil Image komponenti Authorization sarlavhasi bilan oladi; brauzerda inline ko'rsatilmaydi. */
  @Get('users/:id/avatar') @RequirePermission('account.read.self')
  async get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Res() res: any) {
    const f = await this.avatars.fileFor(a, id);
    const data = await this.files.readThumb(f);
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Content-Disposition', 'attachment; filename="avatar.webp"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.status(200).end(data);
  }
}
