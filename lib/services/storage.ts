/**
 * Object storage, behind an interface (spec section 3: S3, private, SSE-KMS,
 * presigned URLs only).
 *
 * Files here are voided checks, ID documents, and signed authorizations. None
 * of them may ever be reachable by URL alone: every URL this module produces is
 * short-lived and bound to a single key, and issuing one is a decision the
 * caller makes after an authorization check, never a property of the object.
 *
 * The `local` provider is a development stand-in with the same shape — signed,
 * expiring URLs over a filesystem directory — so that no call site distinguishes
 * between the two. Swapping to S3 is an environment change.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export interface PutOptions {
  contentType: string;
  /** Bytes. Enforced here as well as at the route, because a presigned PUT skips the route. */
  maxBytes?: number;
}

export interface StorageProvider {
  readonly name: string;
  put(key: string, body: Buffer, options: PutOptions): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** A time-limited URL for reading one object. */
  signedGetUrl(key: string, ttlSeconds: number): Promise<string>;
  /** A time-limited URL the browser may PUT one object to, direct from the device. */
  signedPutUrl(key: string, ttlSeconds: number, contentType: string): Promise<string>;
}

/** 25 MB. A phone photo of a voided check is around 3. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export const ALLOWED_UPLOAD_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/webp',
  'application/pdf',
]);

/**
 * Object keys are generated, never derived from a filename. A user-supplied
 * name reaching a path is how directory traversal happens, and a predictable
 * key is how one company's document becomes guessable from another's.
 */
export function newObjectKey(companyId: string, kind: string, extension: string): string {
  const safeKind = kind.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const safeExt = extension.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  return `${companyId}/${safeKind}/${randomUUID()}${safeExt ? `.${safeExt}` : ''}`;
}

export function extensionForContentType(contentType: string): string {
  switch (contentType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/heic':
      return 'heic';
    case 'image/webp':
      return 'webp';
    case 'application/pdf':
      return 'pdf';
    default:
      return 'bin';
  }
}

// ---------------------------------------------------------------------------
// URL signing, shared by the local provider and the route that serves it
// ---------------------------------------------------------------------------

function signingSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('AUTH_SECRET must be set and at least 32 characters to sign storage URLs.');
  }
  return secret;
}

export function signStorageUrl(key: string, expiresAt: number, method: 'GET' | 'PUT'): string {
  return createHmac('sha256', signingSecret())
    .update(`${method}\n${key}\n${expiresAt}`)
    .digest('base64url');
}

export function verifyStorageUrl(
  key: string,
  expiresAt: number,
  method: 'GET' | 'PUT',
  signature: string,
): boolean {
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;
  const expected = Buffer.from(signStorageUrl(key, expiresAt, method));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// ---------------------------------------------------------------------------
// Local provider
// ---------------------------------------------------------------------------

class LocalStorageProvider implements StorageProvider {
  readonly name = 'local';
  readonly #root: string;
  readonly #origin: string;

  constructor() {
    this.#root = resolve(process.env.LOCAL_STORAGE_DIR ?? '.local-storage');
    this.#origin = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  }

  /**
   * Resolves and then checks containment. A key that escapes the root — through
   * `..`, an absolute path, or a symlink-shaped string — is refused rather than
   * normalized, because a key that needed normalizing did not come from
   * newObjectKey and the interesting question is how it got here.
   */
  #pathFor(key: string): string {
    const full = resolve(join(this.#root, key));
    if (full !== this.#root && !full.startsWith(this.#root + sep)) {
      throw new Error('Refusing an object key that escapes the storage root.');
    }
    return full;
  }

  async put(key: string, body: Buffer, options: PutOptions): Promise<void> {
    const limit = options.maxBytes ?? MAX_UPLOAD_BYTES;
    if (body.byteLength > limit) {
      throw new Error(`Object exceeds the ${limit}-byte limit.`);
    }
    const path = this.#pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    await writeFile(`${path}.type`, options.contentType, 'utf8');
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.#pathFor(key));
  }

  async delete(key: string): Promise<void> {
    const path = this.#pathFor(key);
    await rm(path, { force: true });
    await rm(`${path}.type`, { force: true });
  }

  async signedGetUrl(key: string, ttlSeconds: number): Promise<string> {
    return this.#sign(key, ttlSeconds, 'GET');
  }

  async signedPutUrl(key: string, ttlSeconds: number): Promise<string> {
    return this.#sign(key, ttlSeconds, 'PUT');
  }

  #sign(key: string, ttlSeconds: number, method: 'GET' | 'PUT'): string {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const signature = signStorageUrl(key, expiresAt, method);
    const params = new URLSearchParams({
      key,
      expires: String(expiresAt),
      method,
      sig: signature,
    });
    return `${this.#origin}/api/files?${params.toString()}`;
  }
}

/**
 * S3. Deliberately not implemented: the dependency is not installed, and a
 * half-working object store that silently drops a voided check is worse than an
 * explicit gap. The interface above is what the S3 version satisfies —
 * PutObject with SSE-KMS, GetObject, and presigned URLs — and no call site
 * changes when it lands.
 */
class S3StorageProvider implements StorageProvider {
  readonly name = 's3';
  #unimplemented(): never {
    throw new Error(
      'STORAGE_PROVIDER=s3 is not implemented yet. Install @aws-sdk/client-s3 and ' +
        '@aws-sdk/s3-request-presigner and implement this class. Bucket must be private ' +
        'with SSE-KMS and no public access. No call site changes.',
    );
  }
  async put(): Promise<void> {
    this.#unimplemented();
  }
  async get(): Promise<Buffer> {
    this.#unimplemented();
  }
  async delete(): Promise<void> {
    this.#unimplemented();
  }
  async signedGetUrl(): Promise<string> {
    this.#unimplemented();
  }
  async signedPutUrl(): Promise<string> {
    this.#unimplemented();
  }
}

let provider: StorageProvider | undefined;

export function getStorage(): StorageProvider {
  if (provider) return provider;
  provider =
    (process.env.STORAGE_PROVIDER ?? 'local') === 's3'
      ? new S3StorageProvider()
      : new LocalStorageProvider();
  return provider;
}

/** Test seam. */
export function __setStorageProvider(p: StorageProvider | undefined): void {
  provider = p;
}
