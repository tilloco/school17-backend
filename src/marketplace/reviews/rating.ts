import { marketConfig } from '../common/config';

/**
 * Bayes o'rtachasi: (m*C + yig'indi) / (C + n).
 *  m — oldingi o'rtacha (yangi o'qituvchi shu bahodan boshlaydi), C — oldingi "og'irlik" (nechta baho bilan teng).
 * Bitta 5 yulduzli baho 5.0 ga olib chiqmaydi, ko'p bahoning o'rtachasi esa ishonchliroq.
 */
export function bayesianAverage(sum: number, count: number, priorMean = marketConfig().ratingPriorMean, priorWeight = marketConfig().ratingPriorWeight): number {
  if (count < 0 || sum < 0) throw new Error('Invalid rating totals');
  return (priorMean * priorWeight + sum) / (priorWeight + count);
}
