import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsArray, IsBoolean, IsOptional } from 'class-validator';
import { Actor } from '../common/actor';
import { CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { ClassBoardService } from './class-board.service';

class BoardDto { @IsArray() strokes!: unknown[]; }
class SaveDto { @IsOptional() @IsBoolean() clear?: boolean; }

@Controller()
@UseGuards(UserActorGuard)
export class ClassBoardController {
  constructor(private board: ClassBoardService) {}

  @Get('class-sessions/:sid/whiteboard') @RequirePermission('class.read')
  get(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string) { return this.board.get(a, sid); }

  // Mijoz har 15 soniyada (o'zgargan bo'lsa) yuboradi; 12/daqiqa chegarasi bundan ancha yuqori
  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  @Put('class-sessions/:sid/whiteboard') @RequirePermission('class.manage')
  put(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string, @Body() dto: BoardDto) { return this.board.put(a, sid, dto.strokes); }

  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @Post('class-sessions/:sid/whiteboard/save') @HttpCode(201) @RequirePermission('class.manage')
  save(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string, @Body() dto: SaveDto) { return this.board.save(a, sid, !!dto.clear); }

  @Get('classes/:id/feed') @RequirePermission('class.read')
  feed(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Query('before') before?: string) { return this.board.feed(a, id, before); }

  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @Get('classes/:id/feed/:pid/image') @RequirePermission('class.read')
  async image(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Param('pid', ParseUUIDPipe) pid: string, @Res() res: any) {
    const buf = await this.board.feedImage(a, id, pid);
    res.set({ 'content-type': 'image/png', 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" });
    res.send(buf);
  }
}
