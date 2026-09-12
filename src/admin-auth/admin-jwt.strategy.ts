import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AdminJwtStrategy extends PassportStrategy(Strategy, 'admin-jwt') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('ADMIN_JWT_SECRET'),
    });
  }

  // Qaytgan obyekt @Req() req -> req.admin sifatida admin controller'larda ko'rinadi
  async validate(payload: { sub: string; email: string; role: string }) {
    return { adminId: payload.sub, email: payload.email, role: payload.role };
  }
}
