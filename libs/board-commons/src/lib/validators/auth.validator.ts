import { z } from 'zod';

// Trimmed and lower-cased before the format check, the same form the API
// stores and matches on.
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email().max(320));

export const passwordSchema = z.string().min(8).max(128);

// No control or format characters (bidi overrides, zero-width joiners), so a
// name can't impersonate another one.
export const displayNameSchema = z
  .string()
  .normalize('NFC')
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\p{Cc}\p{Cf}]*$/u);
