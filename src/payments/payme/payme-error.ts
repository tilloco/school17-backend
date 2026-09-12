// Payme Merchant API standart xato kodlari (developer.help.paycom.uz)
export const PaymeErrorCode = {
  INVALID_AMOUNT: -31001,
  TRANSACTION_NOT_FOUND: -31003,
  ORDER_FULFILLED_CANNOT_CANCEL: -31007,
  CANNOT_PERFORM_OPERATION: -31008,
  ACCOUNT_NOT_FOUND: -31050, // -31050..-31099 oralig'i "account" bo'yicha xatolar uchun
  METHOD_NOT_FOUND: -32601,
  INSUFFICIENT_PRIVILEGE: -32504, // login/parol (Basic Auth) noto'g'ri
  SYSTEM_ERROR: -32400,
} as const;

// Payme har doim JSON-RPC formatida xato kutadi (HTTP 200 bilan), oddiy Nest
// HttpException emas - shuning uchun alohida class: controller buni ushlab,
// to'g'ri { error: {...} } formatiga o'giradi.
export class PaymeRpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: string,
  ) {
    super(message);
  }
}
