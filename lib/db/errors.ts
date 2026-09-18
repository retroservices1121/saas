/**
 * Recognises a unique-constraint violation from postgres.js without importing
 * its error class into every action. `constraint` narrows to one index so a
 * collision on some other column is not mistaken for the one being handled.
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { code?: unknown; constraint_name?: unknown };
  return e.code === '23505' && e.constraint_name === constraint;
}

/** users.email is unique across every role and tenant. */
export const USERS_EMAIL_UNIQUE = 'users_email_unique';
