export interface ChargeInput {
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
  payerRef: string;
  description: string;
}
export interface ChargeResult {
  status: 'SUCCEEDED' | 'FAILED';
  providerRef: string;
  failureCode?: string;
}
export interface RefundInput {
  providerRef: string;
  amountMinor: number;
  idempotencyKey: string;
}
export interface PayoutInput {
  amountMinor: number;
  destination: string;
  idempotencyKey: string;
}
export interface PayoutResult {
  status: 'SUCCEEDED' | 'FAILED';
  providerRef: string;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

/**
 * To'lov provayderi abstraksiyasi. HAQIQIY provayder YO'Q (kalitlar va yuridik shaxs kerak, PAYMENTS_GAPS.md).
 * Barcha chaqiruvlar idempotent bo'lishi shart: bir xil idempotencyKey bir xil natija beradi va ikki marta pul yechmaydi.
 */
export interface PaymentProvider {
  readonly name: string;
  charge(i: ChargeInput): Promise<ChargeResult>;
  refund(i: RefundInput): Promise<{ providerRef: string }>;
  payout(i: PayoutInput): Promise<PayoutResult>;
}

/** Faqat dev/test: pul harakati YO'Q. payerRef "decline" so'zini o'z ichiga olsa to'lov rad etiladi; destination "fail" bo'lsa payout xato. */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  readonly charges = new Map<string, ChargeResult & { amountMinor: number }>();
  readonly refunds = new Map<string, { providerRef: string; amountMinor: number }>();
  readonly payouts = new Map<string, PayoutResult & { amountMinor: number }>();
  /** Test uchun: chaqiruvlar soni (idempotentlikni isbotlash) */
  calls = { charge: 0, refund: 0, payout: 0 };

  async charge(i: ChargeInput): Promise<ChargeResult> {
    this.calls.charge++;
    const prev = this.charges.get(i.idempotencyKey);
    if (prev) {
      if (prev.amountMinor !== i.amountMinor) throw new Error('Idempotency key reused with different amount');
      return { status: prev.status, providerRef: prev.providerRef, failureCode: prev.failureCode };
    }
    const declined = i.payerRef.includes('decline');
    const res = { status: declined ? ('FAILED' as const) : ('SUCCEEDED' as const), providerRef: `mock_ch_${this.charges.size + 1}_${i.idempotencyKey.slice(0, 8)}`, failureCode: declined ? 'card_declined' : undefined, amountMinor: i.amountMinor };
    this.charges.set(i.idempotencyKey, res);
    return { status: res.status, providerRef: res.providerRef, failureCode: res.failureCode };
  }

  async refund(i: RefundInput) {
    this.calls.refund++;
    const prev = this.refunds.get(i.idempotencyKey);
    if (prev) return { providerRef: prev.providerRef };
    const res = { providerRef: `mock_rf_${this.refunds.size + 1}`, amountMinor: i.amountMinor };
    this.refunds.set(i.idempotencyKey, res);
    return { providerRef: res.providerRef };
  }

  async payout(i: PayoutInput): Promise<PayoutResult> {
    this.calls.payout++;
    const prev = this.payouts.get(i.idempotencyKey);
    if (prev) return { status: prev.status, providerRef: prev.providerRef };
    const res = { status: i.destination.includes('fail') ? ('FAILED' as const) : ('SUCCEEDED' as const), providerRef: `mock_po_${this.payouts.size + 1}`, amountMinor: i.amountMinor };
    this.payouts.set(i.idempotencyKey, res);
    return { status: res.status, providerRef: res.providerRef };
  }
}

export function createPaymentProvider(env: NodeJS.ProcessEnv = process.env): PaymentProvider {
  const kind = (env.PAYMENT_PROVIDER || 'mock').toLowerCase();
  if (kind !== 'mock') throw new Error(`PAYMENT_PROVIDER "${kind}" is not implemented (only "mock"); see PAYMENTS_GAPS.md`);
  return new MockPaymentProvider();
}
