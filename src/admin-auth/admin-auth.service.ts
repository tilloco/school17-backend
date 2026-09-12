import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminAuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  // XAVFSIZLIK: admin token'lari oddiy foydalanuvchi JWT'sidan BUTUNLAY ALOHIDA
  // maxfiy kalit (ADMIN_JWT_SECRET) bilan imzolanadi va payload'da role saqlanadi.
  // Shuning uchun oddiy foydalanuvchi tokeni hech qachon admin endpointlarda
  // ishlamaydi (imzo mos kelmaydi) - ikkita tizim bir-biriga aralashmaydi.
  async login(email: string, password: string) {
    const admin = await this.prisma.admin.findUnique({ where: { email } });

    // Email topilmasa ham bcrypt.compare vaqtiga yaqin vaqt sarflab, "email mavjud/
    // mavjud emas"ni javob vaqtidan bilib olishning (timing attack) oldini olamiz
    const passwordHash = admin?.passwordHash ?? '$2b$10$invalidsaltinvalidsaltinvalidsaltO';
    const isValid = await bcrypt.compare(password, passwordHash);

    if (!admin || !isValid) {
      throw new UnauthorizedException("Email yoki parol noto'g'ri");
    }

    const accessToken = this.jwt.sign(
      { sub: admin.id, email: admin.email, role: admin.role },
      {
        secret: this.config.get<string>('ADMIN_JWT_SECRET'),
        expiresIn: this.config.get<string>('ADMIN_JWT_EXPIRES_IN') || '12h',
      },
    );

    return {
      accessToken,
      admin: { id: admin.id, email: admin.email, role: admin.role },
    };
  }
}
