import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { marketConfig } from '../common/config';

/** Bepul rejimda (ESCROW_ENABLED != true) to'lov/daromad/payout marshrutlari umuman mavjud emas: 404 (autentifikatsiyadan OLDIN). */
@Injectable()
export class EscrowEnabledGuard implements CanActivate {
  canActivate(): boolean {
    if (!marketConfig().escrowEnabled) throw new NotFoundException();
    return true;
  }
}
