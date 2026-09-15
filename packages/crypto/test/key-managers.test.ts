/**
 * The key managers.
 *
 * The KMS manager is tested against a double rather than real KMS, and the
 * double records the exact resource names each call used. That is the part most
 * likely to be wrong and the part a live integration test would obscure: it is
 * easy to write code that works with one key version and silently stops working
 * after a rotation, and the only visible difference is which name was passed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  KeyManagerError,
  KmsKeyManager,
  LOCAL_KEY_ID_PREFIX,
  LocalKeyManager,
  assertCryptoKeyName,
  assertNotProduction,
  cryptoKeyNameFor,
  needsRewrap,
  open,
  openText,
  resolveKeyManager,
  rewrap,
  seal,
  type KmsLike,
} from '../src/index';

const KEY_NAME = 'projects/hebrew-dates/locations/global/keyRings/app/cryptoKeys/oauth-tokens';
const context = { purpose: 'google.refresh_token', subject: 'user-1' };

/* ------------------------------------------------------------ KMS double -- */

interface RecordedCall {
  method: 'encrypt' | 'decrypt' | 'getCryptoKey';
  name: string;
}

/**
 * A stand-in for Google Cloud KMS.
 *
 * Behaves like a symmetric key: `decrypt` takes the crypto KEY name and finds
 * the version from the ciphertext, and `encrypt` reports the primary version it
 * used. Both of those are the behaviours the real service has and that the
 * manager's rotation handling depends on.
 */
class FakeKms implements KmsLike {
  readonly calls: RecordedCall[] = [];
  /** Master key per version, so a rotated-away version still decrypts. */
  readonly #versionKeys = new Map<number, Buffer>();
  #primaryVersion = 1;
  /** Set to make the next call of a given kind fail. */
  failNext: Partial<Record<RecordedCall['method'], Error>> = {};
  /** REST transport returns base64 strings; gRPC returns bytes. */
  transport: 'rest' | 'grpc' = 'grpc';

  constructor(private readonly keyName = KEY_NAME) {
    this.#versionKeys.set(1, randomBytes(32));
  }

  rotate(): string {
    this.#primaryVersion += 1;
    this.#versionKeys.set(this.#primaryVersion, randomBytes(32));
    return this.primaryName();
  }

  primaryName(): string {
    return `${this.keyName}/cryptoKeyVersions/${this.#primaryVersion}`;
  }

  #maybeFail(method: RecordedCall['method']): void {
    const error = this.failNext[method];
    if (error) {
      delete this.failNext[method];
      throw error;
    }
  }

  #encode(value: Buffer): Uint8Array | string {
    return this.transport === 'rest' ? value.toString('base64') : new Uint8Array(value);
  }

  async encrypt(request: { name: string; plaintext: Buffer }) {
    this.calls.push({ method: 'encrypt', name: request.name });
    this.#maybeFail('encrypt');
    if (request.name !== this.keyName) {
      throw new Error(`NOT_FOUND: ${request.name}`);
    }

    const version = this.#primaryVersion;
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#versionKeys.get(version) as Buffer, nonce);
    const body = Buffer.concat([cipher.update(request.plaintext), cipher.final()]);
    // The version is written into the ciphertext, exactly as KMS does, so
    // decrypt can find it without being told.
    const versionByte = Buffer.from([version]);
    const ciphertext = Buffer.concat([versionByte, nonce, cipher.getAuthTag(), body]);

    return [
      { name: this.primaryName(), ciphertext: this.#encode(ciphertext) },
    ] as [{ name?: string | null; ciphertext?: Uint8Array | string | null }];
  }

  async decrypt(request: { name: string; ciphertext: Buffer }) {
    this.calls.push({ method: 'decrypt', name: request.name });
    this.#maybeFail('decrypt');
    // The real service rejects a version name here for a symmetric key.
    if (request.name !== this.keyName) {
      throw new Error(`INVALID_ARGUMENT: expected a CryptoKey name, got ${request.name}`);
    }

    const version = request.ciphertext.readUInt8(0);
    const key = this.#versionKeys.get(version);
    if (!key) throw new Error(`FAILED_PRECONDITION: unknown version ${version}`);

    const nonce = request.ciphertext.subarray(1, 13);
    const tag = request.ciphertext.subarray(13, 29);
    const body = request.ciphertext.subarray(29);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);

    return [{ plaintext: this.#encode(plaintext) }] as [
      { plaintext?: Uint8Array | string | null },
    ];
  }

  async getCryptoKey(request: { name: string }) {
    this.calls.push({ method: 'getCryptoKey', name: request.name });
    this.#maybeFail('getCryptoKey');
    return [{ primary: { name: this.primaryName() } }] as [
      { primary?: { name?: string | null } | null },
    ];
  }
}

/* --------------------------------------------------------- KmsKeyManager -- */

describe('KmsKeyManager', () => {
  it('round-trips a secret', async () => {
    const kms = new FakeKms();
    const keys = new KmsKeyManager({ keyName: KEY_NAME, client: kms });
    const sealed = await seal(keys, 'refresh-token', context);
    await expect(openText(keys, sealed, context)).resolves.toBe('refresh-token');
  });

  it('encrypts against the crypto key, so writes use the primary version', async () => {
    const kms = new FakeKms();
    const keys = new KmsKeyManager({ keyName: KEY_NAME, client: kms });
    await seal(keys, 'x', context);

    const encrypts = kms.calls.filter((call) => call.method === 'encrypt');
    expect(encrypts).toHaveLength(1);
    // Not a version name: pinning writes to a version would make rotation a
    // no-op.
    expect(encrypts[0]?.name).toBe(KEY_NAME);
  });

  it('records the exact key version that performed the encryption', async () => {
    const kms = new FakeKms();
    const keys = new KmsKeyManager({ keyName: KEY_NAME, client: kms });
    const sealed = await seal(keys, 'x', context);
    expect(sealed.keyId).toBe(`${KEY_NAME}/cryptoKeyVersions/1`);
  });

  it('decrypts against the crypto key, not the stored version', async () => {
    const kms = new FakeKms();
    const keys = new KmsKeyManager({ keyName: KEY_NAME, client: kms });
    const sealed = await seal(keys, 'x', context);
    kms.calls.length = 0;

    await open(keys, sealed, context);
    const decrypts = kms.calls.filter((call) => call.method === 'decrypt');
    expect(decrypts).toHaveLength(1);
    // The version suffix is stripped. Passing the version would be rejected by
    // the real service for a symmetric key.
    expect(decrypts[0]?.name).toBe(KEY_NAME);
  });

  it('still reads a record sealed before a rotation', async () => {
    // The scenario: a key is rotated while thousands of tokens are stored
    // under the old version. None of them may become unreadable.
    const kms = new FakeKms();
    const keys = new KmsKeyManager({ keyName: KEY_NAME, client: kms, now: () => 0 });
    const old = await seal(keys, 'old-token', context);

    kms.rotate();
    await expect(openText(keys, old, context)).resolves.toBe('old-token');
  });

  it('marks pre-rotation records as needing a re-wrap, and re-wraps them', async () => {
    let clock = 0;
    const kms = new FakeKms();
    const keys = new KmsKeyManager({ keyName: KEY_NAME, client: kms, now: () => clock });

    const old = await seal(keys, 'old-token', context);
    await expect(needsRewrap(keys, old)).resolves.toBe(false);

    kms.rotate();
    // Past the primary-version cache window.
    clock += 10 * 60 * 1000;
    await expect(needsRewrap(keys, old)).resolves.toBe(true);

    const rotated = await rewrap(keys, old, context);
    expect(rotated.keyId).toBe(`${KEY_NAME}/cryptoKeyVersions/2`);
    await expect(needsRewrap(keys, rotated)).resolves.toBe(false);
    await expect(openText(keys, rotated, context)).resolves.toBe('old-token');
  });

  it('caches the primary version so it is not read on every write', async () => {
    let clock = 0;
    const kms = new FakeKms();
    const keys = new KmsKeyManager({ keyName: KEY_NAME, client: kms, now: () => clock });

    for (let index = 0; index < 5; index += 1) await keys.currentKeyId();
    expect(kms.calls.filter((call) => call.method === 'getCryptoKey')).toHaveLength(1);

    clock += 5 * 60 * 1000 + 1;
    await keys.currentKeyId();
    expect(kms.calls.filter((call) => call.method === 'getCryptoKey')).toHaveLength(2);
  });

  it('serves a stale primary version rather than failing a write', async () => {
    let clock = 0;
    const kms = new FakeKms();
    const keys = new KmsKeyManager({ keyName: KEY_NAME, client: kms, now: () => clock });
    await keys.currentKeyId();

    clock += 10 * 60 * 1000;
    kms.failNext.getCryptoKey = new Error('UNAVAILABLE: kms is having a moment');
    // Being a few minutes late to schedule a re-wrap is harmless; refusing to
    // store a token because KMS metadata was briefly unavailable is not.
    await expect(keys.currentKeyId()).resolves.toBe(`${KEY_NAME}/cryptoKeyVersions/1`);
  });

  it('fails loudly if the primary version was never known', async () => {
    const kms = new FakeKms();
    kms.failNext.getCryptoKey = new Error('PERMISSION_DENIED');
    const keys = new KmsKeyManager({ keyName: KEY_NAME, client: kms });
    // One call: with nothing cached there is no stale answer to fall back on,
    // so the failure must surface.
    const error = await keys.currentKeyId().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(KeyManagerError);
    expect((error as Error).message).toMatch(/PERMISSION_DENIED/);
  });

  it('names the resource in its errors, because a wrong project is the usual cause', async () => {
    const kms = new FakeKms();
    kms.failNext.encrypt = new Error('PERMISSION_DENIED: caller lacks cloudkms.cryptoKeyVersions.useToEncrypt');
    const keys = new KmsKeyManager({ keyName: KEY_NAME, client: kms });
    await expect(seal(keys, 'x', context)).rejects.toThrow(KEY_NAME);
  });

  it('handles both the REST and gRPC encodings', async () => {
    for (const transport of ['rest', 'grpc'] as const) {
      const kms = new FakeKms();
      kms.transport = transport;
      const keys = new KmsKeyManager({ keyName: KEY_NAME, client: kms });
      const sealed = await seal(keys, `token-${transport}`, context);
      await expect(openText(keys, sealed, context)).resolves.toBe(`token-${transport}`);
    }
  });

  it('rejects an empty ciphertext from KMS rather than storing it', async () => {
    const kms = new FakeKms();
    const keys = new KmsKeyManager({
      keyName: KEY_NAME,
      client: {
        ...kms,
        encrypt: async () => [{ name: kms.primaryName(), ciphertext: new Uint8Array() }],
        decrypt: kms.decrypt.bind(kms),
        getCryptoKey: kms.getCryptoKey.bind(kms),
      },
    });
    await expect(seal(keys, 'x', context)).rejects.toThrow(/no ciphertext/);
  });

  it('reports a key with no primary version as a misconfiguration', async () => {
    const kms = new FakeKms();
    const keys = new KmsKeyManager({
      keyName: KEY_NAME,
      client: {
        encrypt: kms.encrypt.bind(kms),
        decrypt: kms.decrypt.bind(kms),
        getCryptoKey: async () => [{ primary: null }],
      },
    });
    await expect(keys.currentKeyId()).rejects.toThrow(/symmetric ENCRYPT_DECRYPT key is required/);
  });
});

describe('key name handling', () => {
  it('accepts a well-formed crypto key name', () => {
    expect(assertCryptoKeyName(KEY_NAME)).toBe(KEY_NAME);
  });

  it('refuses a version name, explaining why', () => {
    expect(() => assertCryptoKeyName(`${KEY_NAME}/cryptoKeyVersions/3`)).toThrow(
      /rotating the key has no effect/,
    );
  });

  it.each([
    'oauth-tokens',
    'projects/p/locations/l/keyRings/r',
    'projects/p/locations/l/cryptoKeys/k',
    'projects//locations/l/keyRings/r/cryptoKeys/k',
    '',
  ])('refuses "%s"', (value) => {
    expect(() => assertCryptoKeyName(value)).toThrow(KeyManagerError);
  });

  it('strips a version suffix to recover the crypto key name', () => {
    expect(cryptoKeyNameFor(`${KEY_NAME}/cryptoKeyVersions/42`)).toBe(KEY_NAME);
    expect(cryptoKeyNameFor(KEY_NAME)).toBe(KEY_NAME);
  });

  it('refuses a stored key id that is not a KMS name at all', () => {
    // e.g. a record written by the local key manager, then read in production.
    expect(() => cryptoKeyNameFor('local-dev-key/1')).toThrow(/different key manager/);
  });
});

/* ------------------------------------------------------- LocalKeyManager -- */

describe('LocalKeyManager', () => {
  it('round-trips a secret', async () => {
    const keys = LocalKeyManager.ephemeral();
    const sealed = await seal(keys, 'refresh-token', context);
    await expect(openText(keys, sealed, context)).resolves.toBe('refresh-token');
  });

  it('demands a 32-byte master key and says how to make one', () => {
    expect(
      () => new LocalKeyManager({ masterKey: Buffer.alloc(16), allowInProduction: true }),
    ).toThrow(/openssl rand -base64 32/);
  });

  it('reads a base64 master key from the environment', async () => {
    const keys = LocalKeyManager.fromEnvironment({
      LOCAL_ENVELOPE_MASTER_KEY: randomBytes(32).toString('base64'),
      NODE_ENV: 'test',
    } as NodeJS.ProcessEnv);
    const sealed = await seal(keys, 'x', context);
    expect(sealed.keyId).toBe(`${LOCAL_KEY_ID_PREFIX}/1`);
  });

  it('explains what to set when the environment is empty', () => {
    expect(() => LocalKeyManager.fromEnvironment({} as NodeJS.ProcessEnv)).toThrow(
      /LOCAL_ENVELOPE_MASTER_KEY is not set/,
    );
  });

  it('refuses a record sealed under a different local key id', async () => {
    const first = LocalKeyManager.ephemeral('local-dev-key/1');
    const second = LocalKeyManager.ephemeral('local-dev-key/2');
    const sealed = await seal(first, 'x', context);
    await expect(open(second, sealed, context)).rejects.toThrow(/sealed under/);
  });
});

describe('the production guard', () => {
  it('allows development and preview', () => {
    expect(() => assertNotProduction({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).not.toThrow();
    expect(() => assertNotProduction({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).not.toThrow();
    // A Vercel preview runs with NODE_ENV=production, so VERCEL_ENV is what
    // actually distinguishes it.
    expect(() =>
      assertNotProduction({ NODE_ENV: 'production', VERCEL_ENV: 'preview' } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it('refuses production', () => {
    expect(() =>
      assertNotProduction({ NODE_ENV: 'production', VERCEL_ENV: 'production' } as NodeJS.ProcessEnv),
    ).toThrow(KeyManagerError);
    // No VERCEL_ENV at all: a plain Node production deployment.
    expect(() => assertNotProduction({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(
      KeyManagerError,
    );
  });

  it('is enforced when a LocalKeyManager is constructed', () => {
    const environment = process.env.NODE_ENV;
    const vercel = process.env.VERCEL_ENV;
    try {
      process.env.NODE_ENV = 'production';
      process.env.VERCEL_ENV = 'production';
      expect(() => new LocalKeyManager({ masterKey: randomBytes(32) })).toThrow(
        /must not be used in production/,
      );
    } finally {
      if (environment === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = environment;
      if (vercel === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = vercel;
    }
  });
});

/* ----------------------------------------------------------- resolution -- */

describe('resolveKeyManager', () => {
  it('prefers KMS whenever a key name is configured', () => {
    const resolved = resolveKeyManager({
      KMS_KEY_NAME: KEY_NAME,
      LOCAL_ENVELOPE_MASTER_KEY: randomBytes(32).toString('base64'),
      NODE_ENV: 'development',
    } as NodeJS.ProcessEnv);
    // Both configured: KMS wins, so a leftover local key cannot shadow it.
    expect(resolved.backend).toBe('kms');
    expect(resolved.description).toContain(KEY_NAME);
  });

  it('falls back to the local key outside production', () => {
    const resolved = resolveKeyManager({
      LOCAL_ENVELOPE_MASTER_KEY: randomBytes(32).toString('base64'),
      NODE_ENV: 'development',
    } as NodeJS.ProcessEnv);
    expect(resolved.backend).toBe('local');
    expect(resolved.description).toContain('NOT for production');
  });

  it('refuses to resolve anything in production without KMS', () => {
    expect(() =>
      resolveKeyManager({
        LOCAL_ENVELOPE_MASTER_KEY: randomBytes(32).toString('base64'),
        NODE_ENV: 'production',
        VERCEL_ENV: 'production',
      } as NodeJS.ProcessEnv),
    ).toThrow(/must not be used in production/);
  });

  it('explains both options when nothing is configured', () => {
    expect(() => resolveKeyManager({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toThrow(
      /Set KMS_KEY_NAME .* or LOCAL_ENVELOPE_MASTER_KEY/s,
    );
  });

  it('never puts key material in the description', () => {
    const masterKey = randomBytes(32).toString('base64');
    const resolved = resolveKeyManager({
      LOCAL_ENVELOPE_MASTER_KEY: masterKey,
      NODE_ENV: 'development',
    } as NodeJS.ProcessEnv);
    // The description is logged at startup and shown in diagnostics.
    expect(resolved.description).not.toContain(masterKey);
  });
});

describe('service-account credentials', () => {
  // The variable Google's own ADC looks for is a *file path*, and a serverless
  // platform has no file to point it at — so the JSON is accepted inline. These
  // assertions exist because a wrong value here fails at the first KMS call
  // with an opaque error, long after deploy.
  const original = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

  afterEach(() => {
    if (original === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    else process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = original;
  });

  it('refuses a value that is not JSON, naming the variable', () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = 'not json at all';
    expect(() => new KmsKeyManager({ keyName: KEY_NAME })).toThrow(
      /GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON/,
    );
  });

  it('refuses JSON that is not a service-account key', () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = JSON.stringify({ hello: 'world' });
    expect(() => new KmsKeyManager({ keyName: KEY_NAME })).toThrow(
      /missing client_email or private_key/,
    );
  });

  it('accepts a well-formed service-account key', () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = JSON.stringify({
      type: 'service_account',
      project_id: 'hebrew-dates',
      client_email: 'app@hebrew-dates.iam.gserviceaccount.com',
      // Deliberately escaped: several dashboards store it this way, and the
      // resulting failure is very hard to diagnose from the error alone.
      private_key: '-----BEGIN PRIVATE KEY-----\\nZm9v\\n-----END PRIVATE KEY-----\\n',
    });
    expect(() => new KmsKeyManager({ keyName: KEY_NAME })).not.toThrow();
  });

  it('leaves Application Default Credentials alone when the variable is unset', () => {
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    // Constructing the real client must still work: on Cloud Run or a developer
    // machine with `gcloud auth application-default login`, ADC is correct.
    expect(() => new KmsKeyManager({ keyName: KEY_NAME })).not.toThrow();
  });
});
