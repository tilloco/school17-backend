/** @nom qoidalari: lotin kichik harf bilan boshlanadi, harf/raqam/pastki chiziq, 3..20 belgi. */
export const USERNAME_RE = /^[a-z][a-z0-9_]{2,19}$/;
const RESERVED = new Set(['admin', 'administrator', 'support', 'help', 'school17', 'school', 'moderator', 'staff', 'system', 'root', 'official', 'teacher', 'student', 'ustoz', 'oquvchi', 'null', 'undefined']);

export function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@/, '').toLowerCase();
}
export function usernameProblem(raw: string): 'BAD_USERNAME' | 'RESERVED_USERNAME' | null {
  const u = normalizeUsername(raw);
  if (!USERNAME_RE.test(u)) return 'BAD_USERNAME';
  if (RESERVED.has(u)) return 'RESERVED_USERNAME';
  return null;
}
