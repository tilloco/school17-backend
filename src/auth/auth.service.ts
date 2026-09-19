import { Injectable, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { OAuth2Client } from 'google-auth-library';

@Injectable()
export class AuthService {
  private googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  async loginWithGoogle(idToken: string): Promise<{ accessToken: string; isNewUser: boolean }> {
    const ticket = await this.googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      throw new BadRequestException("Google tokeni noto'g'ri");
    }

    const email = payload.email.toLowerCase();
    const name = payload.name;

    let user = await this.prisma.user.findUnique({ where: { email } });
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      user = await this.prisma.user.create({
        data: {
          email,
          name,
          referralCode: this.generateReferralCode(),
          streak: { create: { currentCount: 0 } },
        },
      });
    }

    const accessToken = this.jwt.sign({ sub: user.id, email: user.email });
    return { accessToken, isNewUser };
  }

  private generateReferralCode(): string {
    return randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
  }
}