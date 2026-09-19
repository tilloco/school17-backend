import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AdminApiKeyGuard implements CanActivate {
  constructor(private config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const key = req.headers['x-admin-key'];
    const expected = this.config.get<string>('ADMIN_API_KEY');

    if (!expected || !key || key !== expected) {
      throw new UnauthorizedException('Unauthorized');
    }
    return true;
  }
}