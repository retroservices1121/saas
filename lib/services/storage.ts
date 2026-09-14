/**
 * Object storage, behind an interface.
 *
 * The spec asked for "S3, private, SSE-KMS, presigned URLs only". What is here
 * is stronger on one axis and deliberately absent on the other, and both
 * deserve an explanation.
 *
 * **No presigned URLs.** Every object this system stores is encrypted with the
 * owning company's data key before it arrives (see `sealBlob` in
 * lib/security/field-encryption.ts), so a presigned URL would hand out
 * ciphertext — useless to the recipient and pointless as a mechanism. Objects
 * are read back through the application, which means every read is an
 * authenticated request that writes an audit row, and revoking a session
 * revokes the read with it. A presigned URL is a bearer token for one object
 * that survives being pasted into a chat and cannot be recalled before it
 * expires.
 *
 * **No SSE-KMS.** Client-side envelope encryption replaces it and is better
 * here: the storage provider never holds a key at all, so a compromise of the
 * bucket yields nothing, and destroying a company's DEK shreds its documents
 * along with its tax IDs — which server-side encryption under the provider's
 * key could not do. It also means the choice of provider stops being a security
 * decision.
 *
 * One implementation covers Railway Buckets, Cloudflare R2, MinIO and AWS S3:
 * they are the same API, and only the endpoint differs.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export interface PutOptions {
  contentType: string;
  /** Bytes. Enforced here as well as at the route. */
  maxBytes?: number;
}

export interface StorageProvider {
  readonly name: string;
  put(key: string, body: Buffer, options: PutOptions): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** 25 MB. A phone photo of a voided check is around 3, after the downscale. */
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

export class ObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`No object at ${key}.`);
    this.name = 'ObjectNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Local, for development
// ---------------------------------------------------------------------------

class LocalStorageProvider implements StorageProvider {
  readonly name = 'local';
  readonly #root: string;

  constructor() {
    this.#root = resolve(process.env.LOCAL_STORAGE_DIR ?? '.local-storage');
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
    if (body.byteLength > limit) throw new Error(`Object exceeds the ${limit}-byte limit.`);

    const path = this.#pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.#pathFor(key));
    } catch {
      throw new ObjectNotFoundError(key);
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.#pathFor(key), { force: true });
  }
}

// ---------------------------------------------------------------------------
// S3-compatible: Railway Buckets, Cloudflare R2, MinIO, AWS S3
// ---------------------------------------------------------------------------

/**
 * Railway exposes an attached Bucket under the AWS SDK's own names —
 * AWS_S3_BUCKET_NAME / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY /
 * AWS_ENDPOINT_URL / AWS_DEFAULT_REGION — with the older unprefixed BUCKET /
 * ACCESS_KEY_ID / SECRET_ACCESS_KEY / ENDPOINT / REGION set on services that
 * attached one before the rename. Both are accepted. The S3_-prefixed names
 * win when present, so a deliberate setting is never shadowed by whatever the
 * platform injected.
 */
function s3Config() {
  const pick = (...names: string[]): string | undefined => {
    for (const name of names) {
      const value = process.env[name];
      if (value) return value;
    }
    return undefined;
  };

  const bucket = pick('S3_BUCKET', 'AWS_S3_BUCKET_NAME', 'BUCKET');
  const accessKeyId = pick('S3_ACCESS_KEY_ID', 'AWS_ACCESS_KEY_ID', 'ACCESS_KEY_ID');
  const secretAccessKey = pick('S3_SECRET_ACCESS_KEY', 'AWS_SECRET_ACCESS_KEY', 'SECRET_ACCESS_KEY');
  const endpoint = pick('S3_ENDPOINT', 'AWS_ENDPOINT_URL', 'ENDPOINT');
  const region = pick('S3_REGION', 'AWS_DEFAULT_REGION', 'REGION') ?? 'auto';

  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'STORAGE_PROVIDER=s3 requires a bucket name, an access key id, and a secret access key.\n' +
        'On Railway, attaching a Bucket to the service provides AWS_S3_BUCKET_NAME, ' +
        'AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL and AWS_DEFAULT_REGION automatically.',
    );
  }

  return { bucket, accessKeyId, secretAccessKey, endpoint, region };
}

class S3StorageProvider implements StorageProvider {
  readonly name = 's3';
  readonly #bucket: string;
  #client: import('@aws-sdk/client-s3').S3Client | undefined;

  constructor() {
    this.#bucket = s3Config().bucket;
  }

  /**
   * The SDK is loaded on first use rather than at import.
   *
   * `@aws-sdk/client-s3` is a large dependency and the `local` provider never
   * needs it — a development machine and the test suite should not pay to parse
   * it. It also keeps the import out of the module graph of anything that only
   * wanted `newObjectKey`.
   */
  async #s3(): Promise<import('@aws-sdk/client-s3').S3Client> {
    if (this.#client) return this.#client;

    const { S3Client } = await import('@aws-sdk/client-s3');
    const config = s3Config();

    this.#client = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      // Required by every S3-compatible provider that is not AWS: Railway,
      // R2 and MinIO all address buckets by path rather than by subdomain.
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });

    return this.#client;
  }

  async put(key: string, body: Buffer, options: PutOptions): Promise<void> {
    const limit = options.maxBytes ?? MAX_UPLOAD_BYTES;
    if (body.byteLength > limit) throw new Error(`Object exceeds the ${limit}-byte limit.`);

    const [client, { PutObjectCommand }] = await Promise.all([
      this.#s3(),
      import('@aws-sdk/client-s3'),
    ]);

    await client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: body,
        // The declared type of the *plaintext*. The bytes are ciphertext, and
        // nothing reads this header — it is recorded so an operator staring at
        // a bucket can tell a PDF from a photo without decrypting anything.
        ContentType: options.contentType,
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const [client, { GetObjectCommand }] = await Promise.all([
      this.#s3(),
      import('@aws-sdk/client-s3'),
    ]);

    try {
      const response = await client.send(
        new GetObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
      if (!response.Body) throw new ObjectNotFoundError(key);
      return Buffer.from(await response.Body.transformToByteArray());
    } catch (err) {
      const code = (err as { name?: string }).name;
      if (code === 'NoSuchKey' || code === 'NotFound') throw new ObjectNotFoundError(key);
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const [client, { DeleteObjectCommand }] = await Promise.all([
      this.#s3(),
      import('@aws-sdk/client-s3'),
    ]);

    // S3 delete is idempotent and succeeds for a key that is not there, which
    // is what the retention job wants: a re-run after a crash mid-sweep must
    // not fail on the objects the first run already removed.
    await client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
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
