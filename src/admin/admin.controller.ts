import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AdminJwtAuthGuard } from '../admin-auth/admin-jwt-auth.guard';
import { AdminService } from './admin.service';

@Controller('admin')
@UseGuards(AdminJwtAuthGuard) // shu controller'dagi HAR BIR endpoint admin login talab qiladi
export class AdminController {
  constructor(private adminService: AdminService) {}

  // GET /admin/users?search=Ali&status=premium&page=1
  @Get('users')
  listUsers(
    @Query('search') search?: string,
    @Query('status') status?: 'premium' | 'free' | 'all',
    @Query('page') page?: string,
  ) {
    return this.adminService.listUsers({ search, status, page: page ? parseInt(page, 10) : undefined });
  }

  // GET /admin/users/:id
  @Get('users/:id')
  getUserDetail(@Param('id') id: string) {
    return this.adminService.getUserDetail(id);
  }

  // GET /admin/stats
  @Get('stats')
  getStats() {
    return this.adminService.getStats();
  }
}
