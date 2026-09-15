/**
 * A key manager backed by a local master key, for development and tests.
 *
 * This exists so the whole OAuth path can be built and tested before a Google
 * Cloud KMS key exists, and so CI needs no cloud credentials. It is NOT a
 * production key manager: the master key sits in an environment variable, so it
 * appears in process listings and deploy configuration, and it cannot be
 * rotated without re-wrapping every record by hand.
 *
 * `assertNotProduction` is called in the constructor precisely because
 * "temporarily" using this in production is the obvious way for it to go wrong.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { KeyManagerError, type KeyManager, type WrappedKey } from './types';

const MASTER_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const DATA_KEY_BYTES = 32;

export interface LocalKeyManagerOptions {
  /** 32 bytes of master key material. */
  masterKey: Buffer;
  /**
   * Recorded as the key version on every wrap. Named so it is obvious in the
   * database which records were sealed outside a real KMS.
   */
  keyId?: string;
  /**
   * Escape hatch for the tests that verify the production guard itself.
   * Never set this anywhere else.
   */
  allowInProduction?: boolean;
}

export const LOCAL_KEY_ID_PREFIX = 'local-dev-key';

export class LocalKeyManager implements KeyManager {
  readonly name = 'LocalKeyManager';
  readonly #masterKey: Buffer;
  readonly #keyId: string;

  constructor(options: LocalKeyManagerOptions) {
    if (!options.allowInProduction) assertNotProduction();
    if (options.masterKey.length !== MASTER_KEY_BYTES) {
      throw new KeyManagerError(
        `The local master key must be exactly ${MASTER_KEY_BYTES} bytes, ` +
          `got ${options.masterKey.length}. Generate one with ` +
          '`openssl rand -base64 32`.',
      );
    }
    this.#masterKey = Buffer.from(options.masterKey);
    this.#keyId = options.keyId ?? `${LOCAL_KEY_ID_PREFIX}/1`;
  }

  /**
   * Build from `LOCAL_ENVELOPE_MASTER_KEY`, a base64 value.
   *
   * The error says how to produce a key, because the alternative is someone
   * pasting in a short string and getting a confusing length error.
   */
  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): LocalKeyManager {
    const encoded = environment.LOCAL_ENVELOPE_MASTER_KEY;
    if (!encoded) {
      throw new KeyManagerError(
        'LOCAL_ENVELOPE_MASTER_KEY is not set. For local development, generate one with ' +
          '`openssl rand -base64 32`. In production, configure Google Cloud KMS instead ' +
          '(KMS_KEY_NAME) — the local key manager refuses to run there.',
      );
    }
    const masterKey = Buffer.from(encoded, 'base64');
    return new LocalKeyManager({ masterKey });
  }

  /** A throwaway manager with a random key, for tests. */
  static ephemeral(keyId?: string): LocalKeyManager {
    return new LocalKeyManager({
      masterKey: randomBytes(MASTER_KEY_BYTES),
      keyId,
      allowInProduction: true,
    });
  }

  async generateDataKey(): Promise<{ plaintext: Buffer; wrapped: WrappedKey }> {
    const dataKey = randomBytes(DATA_KEY_BYTES);
    return { plaintext: dataKey, wrapped: this.#wrap(dataKey) };
  }

  async unwrapDataKey(wrapped: WrappedKey): Promise<Buffer> {
    if (wrapped.keyId !== this.#keyId) {
      throw new KeyManagerError(
        `This local key manager holds "${this.#keyId}" but the record was sealed under ` +
          `"${wrapped.keyId}". Records cannot be read with a different local master key.`,
      );
    }
    if (wrapped.ciphertext.length <= NONCE_BYTES + TAG_BYTES) {
      throw new KeyManagerError('Wrapped data key is truncated.');
    }

    const nonce = wrapped.ciphertext.subarray(0, NONCE_BYTES);
    const tag = wrapped.ciphertext.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
    const body = wrapped.ciphertext.subarray(NONCE_BYTES + TAG_BYTES);

    const decipher = createDecipheriv('aes-256-gcm', this.#masterKey, nonce);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
      throw new KeyManagerError('Could not unwrap the data key with this local master key.');
    }
  }

  async currentKeyId(): Promise<string> {
    return this.#keyId;
  }

  #wrap(dataKey: Buffer): WrappedKey {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#masterKey, nonce);
    const body = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return {
      ciphertext: Buffer.concat([nonce, cipher.getAuthTag(), body]),
      keyId: this.#keyId,
    };
  }
}

/**
 * Refuse to run in production.
 *
 * Checks Vercel's own variable as well as NODE_ENV, because a preview
 * deployment and a production deployment both run with NODE_ENV=production and
 * only `VERCEL_ENV` tells them apart.
 */
export function assertNotProduction(environment: NodeJS.ProcessEnv = process.env): void {
  const vercelEnvironment = environment.VERCEL_ENV;
  const isProduction =
    vercelEnvironment === 'production' ||
    (vercelEnvironment === undefined && environment.NODE_ENV === 'production');

  if (isProduction) {
    throw new KeyManagerError(
      'LocalKeyManager must not be used in production: its master key lives in an ' +
        'environment variable and cannot be rotated. Configure Google Cloud KMS ' +
        '(KMS_KEY_NAME) instead.',
    );
  }
}
