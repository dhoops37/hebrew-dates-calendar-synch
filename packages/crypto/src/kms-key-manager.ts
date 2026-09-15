/**
 * Key manager backed by Google Cloud KMS.
 *
 * Only the 32-byte data key is sent to KMS, and only to be wrapped and
 * unwrapped; the refresh token itself never leaves the process. That keeps the
 * KMS call small, and it keeps the blast radius of a KMS misconfiguration to
 * "tokens cannot be read" rather than "tokens were disclosed".
 *
 * Rotation. `encrypt` reports which crypto key *version* it used, and that
 * version name is what gets stored in `encryption_key_id`. `decrypt` on a
 * symmetric key takes the crypto *key* name and finds the right version from
 * the ciphertext itself, so a record sealed before a rotation stays readable
 * with no migration. `currentKeyId()` reads the key's primary version, so
 * records needing re-wrapping can be found with a single indexed query:
 *
 *     SELECT id FROM google_accounts WHERE encryption_key_id <> $current
 *
 * Transport. The client is constructed with `fallback: 'rest'`. The default
 * gRPC transport does not survive Vercel's serverless runtime reliably, and
 * this package does two small calls per request — REST is the right trade.
 *
 * Credentials come from Application Default Credentials. On Vercel that means
 * `GOOGLE_APPLICATION_CREDENTIALS_JSON` parsed into the client; the deployment
 * notes in docs/ARCHITECTURE.md spell this out.
 */
import { KeyManagementServiceClient } from '@google-cloud/kms';
import { KeyManagerError, type KeyManager, type WrappedKey } from './types';
import { randomBytes } from 'node:crypto';

const DATA_KEY_BYTES = 32;

/** How long the primary key version is cached before KMS is asked again. */
const PRIMARY_VERSION_TTL_MS = 5 * 60 * 1000;

/**
 * The minimum this package needs from a KMS client.
 *
 * Declared structurally so the tests can substitute a double that records
 * exactly which resource names were used, which is the part most likely to be
 * wrong and the part an integration test against real KMS would not isolate.
 */
export interface KmsLike {
  encrypt(request: { name: string; plaintext: Buffer }): Promise<
    [{ name?: string | null; ciphertext?: Uint8Array | string | null }, ...unknown[]]
  >;
  decrypt(request: { name: string; ciphertext: Buffer }): Promise<
    [{ plaintext?: Uint8Array | string | null }, ...unknown[]]
  >;
  getCryptoKey(request: { name: string }): Promise<
    [{ primary?: { name?: string | null } | null }, ...unknown[]]
  >;
}

export interface KmsKeyManagerOptions {
  /**
   * Fully-qualified crypto key name:
   * `projects/P/locations/L/keyRings/R/cryptoKeys/K`
   *
   * A *version* name is rejected: new writes must go through the key's primary
   * version so that rotating the key actually takes effect.
   */
  keyName: string;
  client?: KmsLike;
  /** Injected in tests; defaults to `Date.now`. */
  now?: () => number;
}

const KEY_NAME_PATTERN =
  /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/;
const VERSION_SUFFIX_PATTERN = /\/cryptoKeyVersions\/\d+$/;

export class KmsKeyManager implements KeyManager {
  readonly name = 'KmsKeyManager';
  readonly #keyName: string;
  readonly #client: KmsLike;
  readonly #now: () => number;
  #cachedPrimary: { keyId: string; readAt: number } | undefined;

  constructor(options: KmsKeyManagerOptions) {
    this.#keyName = assertCryptoKeyName(options.keyName);
    this.#client = options.client ?? createDefaultClient();
    this.#now = options.now ?? Date.now;
  }

  static fromEnvironment(
    environment: NodeJS.ProcessEnv = process.env,
    client?: KmsLike,
  ): KmsKeyManager {
    const keyName = environment.KMS_KEY_NAME;
    if (!keyName) {
      throw new KeyManagerError(
        'KMS_KEY_NAME is not set. It must be the full crypto key name, e.g. ' +
          'projects/my-project/locations/global/keyRings/hebrew-dates/cryptoKeys/oauth-tokens',
      );
    }
    return new KmsKeyManager(client ? { keyName, client } : { keyName });
  }

  async generateDataKey(): Promise<{ plaintext: Buffer; wrapped: WrappedKey }> {
    // Generated locally rather than via KMS's own random source: one fewer
    // network call, and `randomBytes` is a CSPRNG.
    const dataKey = randomBytes(DATA_KEY_BYTES);

    let response: Awaited<ReturnType<KmsLike['encrypt']>>[0];
    try {
      [response] = await this.#client.encrypt({ name: this.#keyName, plaintext: dataKey });
    } catch (error) {
      dataKey.fill(0);
      throw wrapKmsError('wrap a data key', this.#keyName, error);
    }

    const ciphertext = toBuffer(response.ciphertext);
    if (!ciphertext || ciphertext.length === 0) {
      dataKey.fill(0);
      throw new KeyManagerError(`KMS returned no ciphertext for ${this.#keyName}.`);
    }

    // The version that actually performed the encryption. Recording the key
    // name instead would lose the ability to tell which records predate a
    // rotation.
    const keyId = response.name ?? this.#keyName;

    return { plaintext: dataKey, wrapped: { ciphertext, keyId } };
  }

  async unwrapDataKey(wrapped: WrappedKey): Promise<Buffer> {
    // Decrypt against the crypto KEY, not the stored version: KMS resolves the
    // version from the ciphertext, so this keeps working after a rotation.
    // Deriving it from the stored id rather than from `this.#keyName` means a
    // record sealed under a different key in the same project still names its
    // own key.
    const keyName = cryptoKeyNameFor(wrapped.keyId);

    let response: Awaited<ReturnType<KmsLike['decrypt']>>[0];
    try {
      [response] = await this.#client.decrypt({ name: keyName, ciphertext: wrapped.ciphertext });
    } catch (error) {
      throw wrapKmsError('unwrap a data key', keyName, error);
    }

    const plaintext = toBuffer(response.plaintext);
    if (!plaintext || plaintext.length === 0) {
      throw new KeyManagerError(`KMS returned no plaintext when unwrapping under ${keyName}.`);
    }
    return plaintext;
  }

  /**
   * The primary version, cached briefly.
   *
   * Cached because this is called on every write to decide whether a record is
   * stale, and the answer changes only when someone rotates the key. Five
   * minutes means a rotation is picked up promptly without a KMS call per
   * request.
   */
  async currentKeyId(): Promise<string> {
    const cached = this.#cachedPrimary;
    if (cached && this.#now() - cached.readAt < PRIMARY_VERSION_TTL_MS) {
      return cached.keyId;
    }

    let response: Awaited<ReturnType<KmsLike['getCryptoKey']>>[0];
    try {
      [response] = await this.#client.getCryptoKey({ name: this.#keyName });
    } catch (error) {
      // A stale answer is better than failing a write: the only consequence of
      // being wrong is that a re-wrap is scheduled a few minutes late.
      if (cached) return cached.keyId;
      throw wrapKmsError('read the primary key version', this.#keyName, error);
    }

    const primary = response.primary?.name;
    if (!primary) {
      throw new KeyManagerError(
        `${this.#keyName} has no primary version. A symmetric ENCRYPT_DECRYPT key is ` +
          'required; an asymmetric or MAC key will not work here.',
      );
    }

    this.#cachedPrimary = { keyId: primary, readAt: this.#now() };
    return primary;
  }
}

/** Reject a version name, so writes cannot be pinned to a version by accident. */
export function assertCryptoKeyName(keyName: string): string {
  if (VERSION_SUFFIX_PATTERN.test(keyName)) {
    throw new KeyManagerError(
      `KMS_KEY_NAME must name a crypto key, not a version: got "${keyName}". ` +
        'Pinning writes to a version would mean rotating the key has no effect. ' +
        'Drop the /cryptoKeyVersions/N suffix.',
    );
  }
  if (!KEY_NAME_PATTERN.test(keyName)) {
    throw new KeyManagerError(
      `"${keyName}" is not a KMS crypto key name. Expected ` +
        'projects/PROJECT/locations/LOCATION/keyRings/RING/cryptoKeys/KEY',
    );
  }
  return keyName;
}

/** Strip any `/cryptoKeyVersions/N` suffix to get the crypto key name. */
export function cryptoKeyNameFor(keyId: string): string {
  const keyName = keyId.replace(VERSION_SUFFIX_PATTERN, '');
  if (!KEY_NAME_PATTERN.test(keyName)) {
    throw new KeyManagerError(
      `Stored encryption_key_id "${keyId}" is not a KMS key or version name, so the ` +
        'record cannot be decrypted. It may have been written by a different key manager.',
    );
  }
  return keyName;
}

function toBuffer(value: Uint8Array | string | null | undefined): Buffer | undefined {
  if (value === null || value === undefined) return undefined;
  // The REST transport returns base64 strings where gRPC returns bytes, and
  // both are in play depending on the fallback mode.
  return typeof value === 'string' ? Buffer.from(value, 'base64') : Buffer.from(value);
}

function wrapKmsError(action: string, resource: string, error: unknown): KeyManagerError {
  const message = error instanceof Error ? error.message : String(error);
  // The resource name is included because a wrong project, key ring or region is
  // the overwhelmingly common cause, and the raw error does not always say which.
  return new KeyManagerError(`Could not ${action} using ${resource}: ${message}`);
}

function createDefaultClient(): KmsLike {
  // REST rather than gRPC: see the module comment.
  return new KeyManagementServiceClient({
    fallback: 'rest',
    ...serviceAccountCredentials(),
  }) as unknown as KmsLike;
}

/**
 * Credentials for a serverless platform with no writable credentials file.
 *
 * Application Default Credentials looks for `GOOGLE_APPLICATION_CREDENTIALS`,
 * which is a *file path* — and on Vercel there is no file to point it at. So the
 * service-account JSON is accepted inline via
 * `GOOGLE_APPLICATION_CREDENTIALS_JSON` and passed to the client directly.
 *
 * Returns nothing when the variable is unset, which leaves ADC to do its normal
 * job: that is the right behaviour on Cloud Run, GCE, or a developer machine
 * with `gcloud auth application-default login`.
 */
function serviceAccountCredentials(): { credentials?: { client_email: string; private_key: string }; projectId?: string } {
  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!raw) return {};

  let parsed: { client_email?: string; private_key?: string; project_id?: string };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new KeyManagerError(
      'GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON. Paste the whole ' +
        'service-account key file as a single value.',
    );
  }

  if (!parsed.client_email || !parsed.private_key) {
    throw new KeyManagerError(
      'GOOGLE_APPLICATION_CREDENTIALS_JSON is missing client_email or private_key. ' +
        'It should be the service-account key file downloaded from Google Cloud.',
    );
  }

  return {
    credentials: {
      client_email: parsed.client_email,
      // Some dashboards store the value with literal \n sequences rather than
      // real newlines, which makes the key unparseable in a way that is very
      // hard to diagnose from the error alone.
      private_key: parsed.private_key.replace(/\\n/g, '\n'),
    },
    ...(parsed.project_id ? { projectId: parsed.project_id } : {}),
  };
}
