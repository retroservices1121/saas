/**
 * Key management, behind a stable interface.
 *
 * The spec calls for AWS KMS envelope encryption and also asks that this whole
 * area be written so a hosted PII vault can replace it later without touching
 * call sites (section 6). Both requirements point at the same shape: a narrow
 * provider interface with the wrapping algorithm on the far side of it.
 *
 * `local` is a development stand-in, not a weaker design — it performs the same
 * envelope operation with the same algorithm, differing only in where the
 * master key lives. Swapping to `aws` is an environment change.
 */
import { createHash } from 'node:crypto';
// eslint-disable-next-line no-restricted-imports
import { open, randomKey, seal, assertKey } from './aes';

export interface DataKey {
  /** Used immediately, never persisted. */
  plaintext: Buffer;
  /** Persisted in companies.dek_ciphertext. */
  ciphertext: Buffer;
  /** Persisted in companies.dek_key_id — which master key wrapped this DEK. */
  keyId: string;
}

export interface KmsProvider {
  readonly name: string;
  generateDataKey(context: Record<string, string>): Promise<DataKey>;
  decryptDataKey(ciphertext: Buffer, context: Record<string, string>): Promise<Buffer>;
}

/** Encryption context, authenticated but not secret. Binds a DEK to a company. */
function contextToAad(context: Record<string, string>): string {
  return Object.keys(context)
    .sort()
    .map((k) => `${k}=${context[k]}`)
    .join('&');
}

class LocalKmsProvider implements KmsProvider {
  readonly name = 'local';
  readonly #masterKey: Buffer;
  readonly #keyId: string;

  constructor(masterKeyBase64: string) {
    if (!masterKeyBase64) {
      throw new Error(
        'LOCAL_KMS_MASTER_KEY is not set. Generate one with:\n' +
          "  node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
      );
    }
    this.#masterKey = assertKey(Buffer.from(masterKeyBase64, 'base64'), 'LOCAL_KMS_MASTER_KEY');
    // Rotating the master key changes this id, so rows encrypted under the old
    // one remain identifiable rather than becoming undecryptable mysteries.
    this.#keyId = `local:${hashKeyId(this.#masterKey)}`;
  }

  async generateDataKey(context: Record<string, string>): Promise<DataKey> {
    const plaintext = randomKey();
    const ciphertext = seal(this.#masterKey, plaintext.toString('base64'), contextToAad(context));
    return { plaintext, ciphertext, keyId: this.#keyId };
  }

  async decryptDataKey(ciphertext: Buffer, context: Record<string, string>): Promise<Buffer> {
    const b64 = open(this.#masterKey, ciphertext, contextToAad(context));
    return assertKey(Buffer.from(b64, 'base64'), 'unwrapped DEK');
  }
}

function hashKeyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * AWS KMS. Deliberately not implemented yet — the dependency is not installed,
 * and a half-working implementation is worse than an explicit gap. The
 * interface above is what the AWS version will satisfy; call sites do not
 * change when it lands.
 */
class AwsKmsProvider implements KmsProvider {
  readonly name = 'aws';
  async generateDataKey(): Promise<DataKey> {
    throw new Error(
      'KMS_PROVIDER=aws is not implemented yet. Install @aws-sdk/client-kms and ' +
        'implement GenerateDataKey / Decrypt here. No call site changes.',
    );
  }
  async decryptDataKey(): Promise<Buffer> {
    throw new Error('KMS_PROVIDER=aws is not implemented yet.');
  }
}

let provider: KmsProvider | undefined;

export function getKms(): KmsProvider {
  if (provider) return provider;
  const choice = process.env.KMS_PROVIDER ?? 'local';
  provider =
    choice === 'aws'
      ? new AwsKmsProvider()
      : new LocalKmsProvider(process.env.LOCAL_KMS_MASTER_KEY ?? '');
  return provider;
}

/** Test seam. */
export function __setKmsProvider(p: KmsProvider | undefined): void {
  provider = p;
}
