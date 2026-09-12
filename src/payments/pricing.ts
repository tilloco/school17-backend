// XAVFSIZLIK: narx HECH QACHON mobil ilovadan/so'rovdan qabul qilinmaydi - faqat shu
// jadvaldan olinadi. Aks holda foydalanuvchi so'rov tanasini o'zgartirib, masalan
// 3 oylik premiumni 1 so'mga "sotib olishi" mumkin bo'lardi.
//
// Narxlarni haqiqiy qiymatlarga o'zgartiring (so'mda). Buni keyinchalik .env yoki
// admin panel orqali sozlanadigan qilish mumkin (6-bosqichda) - hozircha kod ichida.
export const PREMIUM_PRICING: Record<number, number> = {
  1: 25_000,
  3: 60_000,
};

export function getPriceForMonths(months: number): number {
  const price = PREMIUM_PRICING[months];
  if (!price) {
    throw new Error(`Noma'lum tarif: ${months} oylik narx belgilanmagan`);
  }
  return price;
}
