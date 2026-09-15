import { Query, Body, Controller, Get, Patch, Post, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UsersService } from './users.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { avatarUploadOptions } from './avatar-upload.config';

@Controller('users')
@UseGuards(JwtAuthGuard) // shu controller'dagi har bir endpoint login talab qiladi
export class UsersController {
  constructor(private usersService: UsersService) {}

  // GET /users/me  (Authorization: Bearer <token>)
  @Get('me')
  getProfile(@Req() req: any) {
    return this.usersService.getProfile(req.user.userId);
  }

  // PATCH /users/me  { "name": "Ali", "examDate": "2026-12-15" }
  // Onboarding'da (ism + imtihon sanasi so'ralganda) va profil sozlamalarida ishlatiladi
  @Patch('me')
  updateProfile(@Req() req: any, @Body() dto: UpdateProfileDto) {
    return this.usersService.updateProfile(req.user.userId, dto);
  }

  // POST /users/me/avatar  (multipart/form-data, field name: "avatar")
  // Rasmni serverga saqlaydi va user.avatarUrl ni yangilaydi
  @Post('me/avatar')
  @UseInterceptors(FileInterceptor('avatar', avatarUploadOptions))
  uploadAvatar(@Req() req: any, @UploadedFile() file: Express.Multer.File) {
    return this.usersService.updateAvatar(req.user.userId, file);
  }

  // GET /users/dashboard
  @Get('dashboard')
  getDashboard(@Req() req: any) {
    return this.usersService.getDashboard(req.user.userId);
  }

  // GET /users/search?q=ali — foydalanuvchini ism bo'yicha qidirish (xabar yozish uchun)
  @Get('search')
  searchUsers(@Req() req: any, @Query('q') query: string) {
    return this.usersService.searchUsers(req.user.userId, query || '');
  }
}