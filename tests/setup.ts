import 'dotenv/config';
import { randomBytes } from 'node:crypto';

/**
 * The local KMS provider needs a master key. Tests generate an ephemeral one
 * unless the environment supplies it, so a fresh checkout runs without setup.
 */
if (!process.env.LOCAL_KMS_MASTER_KEY) {
  process.env.LOCAL_KMS_MASTER_KEY = randomBytes(32).toString('base64');
}

// The database requirement is asserted in tests/fixtures.ts, not here, so that
// tests with no database dependency still run on a fresh checkout.
