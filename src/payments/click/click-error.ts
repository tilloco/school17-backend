// Click SHOP API standart xato kodlari (docs.click.uz). Har doim shu kodlardan
// foydalaning - o'zboshimchalik bilan boshqa raqam qaytarish Click tomonida
// integratsiyani rad etilishiga olib kelishi mumkin.
export const ClickError = {
  SUCCESS: 0,
  SIGN_CHECK_FAILED: -1,
  INVALID_AMOUNT: -2,
  ACTION_NOT_FOUND: -3,
  ALREADY_PAID: -4,
  USER_NOT_FOUND: -5,
  TRANSACTION_NOT_FOUND: -6,
  FAILED_TO_UPDATE_USER: -7,
  ERROR_IN_REQUEST: -8,
  TRANSACTION_CANCELLED: -9,
} as const;
