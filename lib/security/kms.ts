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

/**
 * HashiCorp Vault, Transit secrets engine.
 *
 * Transit is a KMS: key material stays inside Vault, the application never sees
 * the master key, every operation is logged in Vault's audit device, and access
 * can be revoked by changing a policy rather than by redeploying. Those four
 * properties are the whole reason to prefer it over a master key in an
 * environment variable, where anyone holding the variable holds every tenant's
 * data and nothing records that they used it.
 *
 * Two Transit endpoints do everything this interface needs:
 *
 *   POST /v1/transit/datakey/plaintext/:key   → { plaintext, ciphertext }
 *   POST /v1/transit/decrypt/:key             → { plaintext }
 *
 * The returned ciphertext is a string of the form `vault:v1:…`, which carries
 * its own key version. That is what makes rotation cheap: `rotate` the Transit
 * key and new DEKs are wrapped under v2 while every existing `vault:v1:` DEK
 * keeps unwrapping, with no re-encryption of anything.
 *
 * ---------------------------------------------------------------------------
 * Setup, once:
 *
 *   vault secrets enable transit
 *   vault write -f transit/keys/onboarding derived=true
 *
 * `derived=true` is the part worth understanding. With it, Transit derives a
 * distinct wrapping key per context — and the context passed here is the
 * company id. Two companies' DEKs are then wrapped under two different keys
 * that Vault computes and never stores, so a wrapped DEK lifted from one
 * company's row cannot be unwrapped as another's even by a caller holding a
 * valid Vault token. That is the same property the local provider gets from
 * AAD, obtained from the key hierarchy instead.
 * ---------------------------------------------------------------------------
 */
class VaultKmsProvider implements KmsProvider {
  readonly name = 'vault';
  readonly #address: string;
  readonly #token: string;
  readonly #keyName: string;
  readonly #mount: string;
  readonly #derived: boolean;
  readonly #namespace: string | undefined;

  constructor() {
    const address = process.env.VAULT_ADDR;
    const token = process.env.VAULT_TOKEN;
    if (!address || !token) {
      throw new Error(
        'KMS_PROVIDER=vault requires VAULT_ADDR and VAULT_TOKEN.\n' +
          'Set up the key once with:\n' +
          '  vault secrets enable transit\n' +
          '  vault write -f transit/keys/onboarding derived=true',
      );
    }

    this.#address = address.replace(/\/$/, '');
    this.#token = token;
    this.#keyName = process.env.VAULT_TRANSIT_KEY ?? 'onboarding';
    this.#mount = (process.env.VAULT_TRANSIT_MOUNT ?? 'transit').replace(/^\/|\/$/g, '');
    // Defaults to true because that is the configuration worth having, and a
    // mismatch fails loudly on the first call rather than silently weakening
    // the key hierarchy.
    this.#derived = (process.env.VAULT_TRANSIT_DERIVED ?? 'true') !== 'false';
    this.#namespace = process.env.VAULT_NAMESPACE;
  }

  async #post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      'X-Vault-Token': this.#token,
      'Content-Type': 'application/json',
    };
    // HCP Vault Dedicated puts every mount under a namespace; Vault OSS does not.
    if (this.#namespace) headers['X-Vault-Namespace'] = this.#namespace;

    const response = await fetch(`${this.#address}/v1/${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      // A KMS that hangs must not hang every request behind it. Failing fast
      // surfaces as an error on one company rather than an exhausted pool.
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      // Vault echoes the request in some error bodies. Report the status and
      // the path, never the body — a wrapped DEK is not something to log.
      throw new Error(`Vault returned ${response.status} for ${path}.`);
    }

    const payload = (await response.json()) as { data?: Record<string, unknown> };
    if (!payload.data) throw new Error(`Vault returned no data for ${path}.`);
    return payload.data;
  }

  /** Base64, which is how Transit takes a derivation context. */
  #contextFor(context: Record<string, string>): string | undefined {
    if (!this.#derived) return undefined;
    const canonical = Object.keys(context)
      .sort()
      .map((key) => `${key}=${context[key]}`)
      .join('&');
    return Buffer.from(canonical, 'utf8').toString('base64');
  }

  async generateDataKey(context: Record<string, string>): Promise<DataKey> {
    const derivation = this.#contextFor(context);
    const data = await this.#post(`${this.#mount}/datakey/plaintext/${this.#keyName}`, {
      bits: 256,
      ...(derivation ? { context: derivation } : {}),
    });

    const plaintext = assertKey(
      Buffer.from(String(data.plaintext), 'base64'),
      'Vault data key',
    );
    const ciphertext = Buffer.from(String(data.ciphertext), 'utf8');

    return {
      plaintext,
      ciphertext,
      // The version travels inside the ciphertext too; recording it here keeps
      // `dek_key_id` meaningful when someone is working out which rows predate
      // a rotation.
      keyId: `vault:${this.#mount}/${this.#keyName}:v${String(data.key_version ?? 1)}`,
    };
  }

  async decryptDataKey(ciphertext: Buffer, context: Record<string, string>): Promise<Buffer> {
    const derivation = this.#contextFor(context);
    const data = await this.#post(`${this.#mount}/decrypt/${this.#keyName}`, {
      ciphertext: ciphertext.toString('utf8'),
      ...(derivation ? { context: derivation } : {}),
    });

    return assertKey(Buffer.from(String(data.plaintext), 'base64'), 'unwrapped DEK');
  }

  /**
   * Proves the token, the mount, the key, and the `derived` setting all agree,
   * by doing the real operation once.
   *
   * A misconfigured KMS otherwise surfaces the first time somebody onboards a
   * company, which is both the worst moment and the hardest place to read the
   * error.
   */
  async preflight(): Promise<void> {
    const probe = await this.generateDataKey({ preflight: 'startup' });
    const unwrapped = await this.decryptDataKey(probe.ciphertext, { preflight: 'startup' });
    if (!unwrapped.equals(probe.plaintext)) {
      throw new Error('Vault Transit round-trip did not return the original key material.');
    }
    probe.plaintext.fill(0);
    unwrapped.fill(0);
  }
}

let provider: KmsProvider | undefined;

export function getKms(): KmsProvider {
  if (provider) return provider;

  switch (process.env.KMS_PROVIDER ?? 'local') {
    case 'vault':
      provider = new VaultKmsProvider();
      break;
    case 'aws':
      provider = new AwsKmsProvider();
      break;
    default:
      provider = new LocalKmsProvider(process.env.LOCAL_KMS_MASTER_KEY ?? '');
  }

  return provider;
}

/**
 * Verifies at boot that the configured provider actually works.
 *
 * Called from instrumentation.ts. For `local` this is a no-op beyond
 * constructing the provider, which already validates the master key length.
 */
export async function preflightKms(): Promise<void> {
  const active = getKms();
  if (active instanceof VaultKmsProvider) await active.preflight();
}

/** Test seam. */
export function __setKmsProvider(p: KmsProvider | undefined): void {
  provider = p;
}
