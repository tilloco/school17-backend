import { Injectable } from '@nestjs/common';
import { LedgerAccount, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { assertMoney } from './money';

export interface Line {
  account: LedgerAccount;
  ownerId?: string | null;
  /** + kirim (hisobga), - chiqim. Yig'indi 0 bo'lishi shart. */
  amount: number;
}

export interface PostInput {
  /** Tranzaksiya kaliti: bir xil kalit ikkinchi marta yozilmaydi (idempotent) */
  key: string;
  kind: string;
  lines: Line[];
  bookingId?: string;
  paymentId?: string;
  payoutId?: string;
}

type Tx = Prisma.TransactionClient;

/**
 * Qo'sh yozuvli daftar. Qoidalar: (1) har bir tranzaksiyada yig'indi 0; (2) yozuvlar o'zgarmaydi (DB trigger);
 * (3) bir kalit bir marta; (4) ichki hisoblar (ESCROW, TEACHER_*, PAYOUT_PENDING) manfiy bo'lolmaydi.
 */
@Injectable()
export class LedgerService {
  constructor(private prisma: PrismaService) {}

  /** @returns true — yangi yozildi, false — bu kalit allaqachon yozilgan (idempotent takror) */
  async post(tx: Tx, input: PostInput): Promise<boolean> {
    const sum = input.lines.reduce((n, l) => n + l.amount, 0);
    if (sum !== 0) throw new Error(`Unbalanced ledger transaction ${input.key}: sum=${sum}`);
    for (const l of input.lines) assertMoney(Math.abs(l.amount), 'ledger amount');
    if (input.lines.some((l) => l.amount === 0)) throw new Error('Zero-amount ledger line');
    const exists = await tx.ledgerEntry.findUnique({ where: { idempotencyKey: `${input.key}:0` } });
    if (exists) return false;
    const txnId = randomUUID();
    for (const [i, l] of input.lines.entries()) {
      await tx.ledgerEntry.create({
        data: {
          txnId, account: l.account, ownerId: l.ownerId ?? null, amountMinor: BigInt(l.amount), kind: input.kind,
          bookingId: input.bookingId, paymentId: input.paymentId, payoutId: input.payoutId, idempotencyKey: `${input.key}:${i}`,
        },
      });
    }
    // Manfiy qoldiq tekshiruvi (tashqi hisoblar manfiy bo'lishi mumkin: ular "pul tashqarida" degani)
    for (const l of input.lines) {
      if (l.amount < 0 && !l.account.startsWith('EXTERNAL')) {
        const bal = await this.balance(l.account, l.ownerId ?? null, tx);
        if (bal < 0) throw new InsufficientFunds(l.account);
      }
    }
    return true;
  }

  async balance(account: LedgerAccount, ownerId: string | null, tx: Tx | PrismaService = this.prisma): Promise<number> {
    const r = await tx.ledgerEntry.aggregate({ where: { account, ownerId }, _sum: { amountMinor: true } });
    return Number(r._sum.amountMinor ?? 0n);
  }

  /** Teacher uchun serializatsiya: bir o'qituvchining pul harakatlari bir vaqtda bitta oqimda (advisory lock). */
  async lockOwner(tx: Tx, ownerId: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ownerId}))`;
  }

  /** Audit: har bir txn yig'indisi 0 va butun daftar yig'indisi 0 bo'lishi kerak. */
  async verifyIntegrity(): Promise<{ ok: boolean; unbalancedTxns: string[]; total: number }> {
    const bad = await this.prisma.$queryRaw<{ txnId: string }[]>`SELECT "txnId" FROM "LedgerEntry" GROUP BY "txnId" HAVING SUM("amountMinor") <> 0`;
    const total = await this.prisma.ledgerEntry.aggregate({ _sum: { amountMinor: true } });
    return { ok: bad.length === 0 && (total._sum.amountMinor ?? 0n) === 0n, unbalancedTxns: bad.map((b) => b.txnId), total: Number(total._sum.amountMinor ?? 0n) };
  }

  async trialBalance(): Promise<Record<string, number>> {
    const rows = await this.prisma.ledgerEntry.groupBy({ by: ['account'], _sum: { amountMinor: true } });
    return Object.fromEntries(rows.map((r) => [r.account, Number(r._sum.amountMinor ?? 0n)]));
  }
}

export class InsufficientFunds extends Error {
  constructor(public account: string) {
    super(`Insufficient funds in ${account}`);
  }
}
