/**
 * Envelope encryption.
 *
 * The properties that matter are negative ones: a ciphertext must not open
 * under the wrong context, a tampered byte must not decrypt, and a truncated
 * blob must produce a clear error rather than a buffer overread. Those are what
 * most of this file asserts.
 */
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  DecryptionFailedError,
  FORMAT,
  KeyManagerError,
  LocalKeyManager,
  MalformedCiphertextError,
  encodeContext,
  needsRewrap,
  open,
  openText,
  parse,
  rewrap,
  seal,
  type KeyManager,
  type SecretContext,
  type WrappedKey,
} from '../src/index';

const REFRESH_TOKEN = '1//0gWj8xQZ_example_refresh_token_with_some_length_to_it';

const context = (overrides: Partial<SecretContext> = {}): SecretContext => ({
  purpose: 'google.refresh_token',
  subject: 'f3c8a1d2-0000-4000-8000-000000000001',
  ...overrides,
});

/** Copy a buffer with one bit flipped. `noUncheckedIndexedAccess` forbids `b[i] ^= 1`. */
function withFlippedBit(source: Buffer, index: number, mask = 0x01): Buffer {
  const copy = Buffer.from(source);
  copy.writeUInt8(copy.readUInt8(index) ^ mask, index);
  return copy;
}

describe('seal and open', () => {
  it('round-trips a refresh token', async () => {
    const keys = LocalKeyManager.ephemeral();
    const sealed = await seal(keys, REFRESH_TOKEN, context());
    await expect(openText(keys, sealed, context())).resolves.toBe(REFRESH_TOKEN);
  });

  it('round-trips arbitrary bytes, including empty and large', async () => {
    const keys = LocalKeyManager.ephemeral();
    for (const plaintext of [Buffer.alloc(0), Buffer.from('a'), randomBytes(64 * 1024)]) {
      const sealed = await seal(keys, plaintext, context());
      const opened = await open(keys, sealed, context());
      expect(opened.equals(plaintext)).toBe(true);
    }
  });

  it('never contains the plaintext', async () => {
    const keys = LocalKeyManager.ephemeral();
    const sealed = await seal(keys, REFRESH_TOKEN, context());
    expect(sealed.ciphertext.includes(Buffer.from(REFRESH_TOKEN, 'utf8'))).toBe(false);
    expect(sealed.ciphertext.toString('utf8')).not.toContain('1//0gWj8xQZ');
    expect(sealed.ciphertext.toString('base64')).not.toContain(
      Buffer.from(REFRESH_TOKEN).toString('base64'),
    );
  });

  it('produces a different ciphertext every time for the same input', async () => {
    // A deterministic ciphertext would leak that two users connected the same
    // account, and would mean a repeated nonce under a repeated key.
    const keys = LocalKeyManager.ephemeral();
    const outputs = await Promise.all(
      Array.from({ length: 12 }, () => seal(keys, REFRESH_TOKEN, context())),
    );
    const distinct = new Set(outputs.map((sealed) => sealed.ciphertext.toString('base64')));
    expect(distinct.size).toBe(12);

    // And every one still opens.
    for (const sealed of outputs) {
      await expect(openText(keys, sealed, context())).resolves.toBe(REFRESH_TOKEN);
    }
  });

  it('uses a fresh nonce for each seal', async () => {
    const keys = LocalKeyManager.ephemeral();
    const nonces = await Promise.all(
      Array.from({ length: 50 }, async () => {
        const sealed = await seal(keys, 'x', context());
        return parse(sealed.ciphertext).nonce.toString('hex');
      }),
    );
    expect(new Set(nonces).size).toBe(50);
  });

  it('records the key version the data key was wrapped under', async () => {
    const keys = LocalKeyManager.ephemeral('local-dev-key/7');
    const sealed = await seal(keys, REFRESH_TOKEN, context());
    expect(sealed.keyId).toBe('local-dev-key/7');
  });

  it('accepts a string or a buffer identically', async () => {
    const keys = LocalKeyManager.ephemeral();
    const fromString = await seal(keys, REFRESH_TOKEN, context());
    const fromBuffer = await seal(keys, Buffer.from(REFRESH_TOKEN, 'utf8'), context());
    await expect(openText(keys, fromString, context())).resolves.toBe(REFRESH_TOKEN);
    await expect(openText(keys, fromBuffer, context())).resolves.toBe(REFRESH_TOKEN);
  });
});

describe('context binding', () => {
  it('refuses to open under a different subject', async () => {
    // The attack this prevents: lifting a ciphertext from one google_accounts
    // row into another, so one user's calendar is written with another's token.
    const keys = LocalKeyManager.ephemeral();
    const sealed = await seal(keys, REFRESH_TOKEN, context());
    await expect(
      open(keys, sealed, context({ subject: 'f3c8a1d2-0000-4000-8000-000000000002' })),
    ).rejects.toThrow(DecryptionFailedError);
  });

  it('refuses to open under a different purpose', async () => {
    // So a PKCE verifier can never be read back as a refresh token.
    const keys = LocalKeyManager.ephemeral();
    const sealed = await seal(keys, REFRESH_TOKEN, context({ purpose: 'oauth.code_verifier' }));
    await expect(open(keys, sealed, context())).rejects.toThrow(DecryptionFailedError);
  });

  it('does not let a purpose/subject split be shifted', async () => {
    // Length-prefixed AAD: 'a' + 'b:c' must not equal 'a:b' + 'c'.
    const left = encodeContext({ purpose: 'a', subject: 'b:c' });
    const right = encodeContext({ purpose: 'a:b', subject: 'c' });
    expect(left.equals(right)).toBe(false);

    const keys = LocalKeyManager.ephemeral();
    const sealed = await seal(keys, 'secret', { purpose: 'a', subject: 'b:c' });
    await expect(open(keys, sealed, { purpose: 'a:b', subject: 'c' })).rejects.toThrow(
      DecryptionFailedError,
    );
  });

  it('reports the same error whatever went wrong', async () => {
    // No oracle: the caller must not be able to tell a wrong subject from a
    // tampered tag.
    const keys = LocalKeyManager.ephemeral();
    const sealed = await seal(keys, REFRESH_TOKEN, context());

    const wrongSubject = await open(keys, sealed, context({ subject: 'other' })).catch(
      (error: Error) => error.message,
    );

    const tampered = withFlippedBit(sealed.ciphertext, sealed.ciphertext.length - 1, 0xff);
    const tamperedMessage = await open(keys, { ...sealed, ciphertext: tampered }, context()).catch(
      (error: Error) => error.message,
    );

    expect(wrongSubject).toBe(tamperedMessage);
  });
});

describe('tamper resistance', () => {
  it('rejects a flipped bit anywhere in the ciphertext body', async () => {
    const keys = LocalKeyManager.ephemeral();
    const sealed = await seal(keys, REFRESH_TOKEN, context());
    const parsed = parse(sealed.ciphertext);
    const bodyStart = sealed.ciphertext.length - parsed.body.length;

    for (let index = bodyStart; index < sealed.ciphertext.length; index += 1) {
      const tampered = withFlippedBit(sealed.ciphertext, index);
      await expect(
        open(keys, { ...sealed, ciphertext: tampered }, context()),
      ).rejects.toThrow(DecryptionFailedError);
    }
  });

  it('rejects a flipped bit in the auth tag', async () => {
    const keys = LocalKeyManager.ephemeral();
    const sealed = await seal(keys, REFRESH_TOKEN, context());
    const parsed = parse(sealed.ciphertext);
    const tagStart = FORMAT.headerBytes + parsed.wrappedKey.length + FORMAT.nonceBytes;

    for (let offset = 0; offset < FORMAT.tagBytes; offset += 1) {
      const tampered = withFlippedBit(sealed.ciphertext, tagStart + offset);
      await expect(
        open(keys, { ...sealed, ciphertext: tampered }, context()),
      ).rejects.toThrow(DecryptionFailedError);
    }
  });

  it('rejects a flipped bit in the nonce', async () => {
    const keys = LocalKeyManager.ephemeral();
    const sealed = await seal(keys, REFRESH_TOKEN, context());
    const parsed = parse(sealed.ciphertext);
    const nonceStart = FORMAT.headerBytes + parsed.wrappedKey.length;

    const tampered = withFlippedBit(sealed.ciphertext, nonceStart);
    await expect(open(keys, { ...sealed, ciphertext: tampered }, context())).rejects.toThrow(
      DecryptionFailedError,
    );
  });

  it('rejects a swapped wrapped key from another ciphertext', async () => {
    // Splicing a valid wrapped key onto another body: the data key no longer
    // matches the body, so the tag fails.
    const keys = LocalKeyManager.ephemeral();
    const a = await seal(keys, 'first', context());
    const b = await seal(keys, 'second', context());
    const parsedA = parse(a.ciphertext);
    const parsedB = parse(b.ciphertext);

    const spliced = Buffer.concat([
      a.ciphertext.subarray(0, FORMAT.headerBytes),
      parsedB.wrappedKey,
      parsedA.nonce,
      parsedA.tag,
      parsedA.body,
    ]);
    await expect(open(keys, { ...a, ciphertext: spliced }, context())).rejects.toThrow();
  });

  it('will not open a ciphertext with another key manager', async () => {
    const sealed = await seal(LocalKeyManager.ephemeral(), REFRESH_TOKEN, context());
    const otherKeys = LocalKeyManager.ephemeral();
    await expect(open(otherKeys, sealed, context())).rejects.toThrow(KeyManagerError);
  });
});

describe('wire format', () => {
  it('starts with the format version', async () => {
    const sealed = await seal(LocalKeyManager.ephemeral(), 'x', context());
    expect(sealed.ciphertext.readUInt8(0)).toBe(FORMAT.version);
  });

  it('refuses an unknown format version', () => {
    const blob = Buffer.alloc(80);
    blob.writeUInt8(99, 0);
    blob.writeUInt16BE(32, 1);
    expect(() => parse(blob)).toThrow(MalformedCiphertextError);
    expect(() => parse(blob)).toThrow(/version 99/);
  });

  it('refuses a blob too short to hold a header', () => {
    expect(() => parse(Buffer.alloc(2))).toThrow(MalformedCiphertextError);
  });

  it('refuses a declared wrapped-key length of zero', () => {
    const blob = Buffer.alloc(80);
    blob.writeUInt8(FORMAT.version, 0);
    blob.writeUInt16BE(0, 1);
    expect(() => parse(blob)).toThrow(/empty wrapped key/);
  });

  it('refuses a truncated blob rather than reading past the end', async () => {
    const sealed = await seal(LocalKeyManager.ephemeral(), REFRESH_TOKEN, context());
    // Every truncation that still has a plausible header must be caught.
    for (let length = FORMAT.headerBytes; length < sealed.ciphertext.length - 1; length += 3) {
      const truncated = sealed.ciphertext.subarray(0, length);
      const parsed = (() => {
        try {
          return parse(truncated);
        } catch (error) {
          expect(error).toBeInstanceOf(MalformedCiphertextError);
          return undefined;
        }
      })();
      // If it parsed at all, the pieces must still be within bounds.
      if (parsed) {
        expect(parsed.nonce).toHaveLength(FORMAT.nonceBytes);
        expect(parsed.tag).toHaveLength(FORMAT.tagBytes);
      }
    }
  });

  it('declares a wrapped-key length that matches what it carries', async () => {
    const sealed = await seal(LocalKeyManager.ephemeral(), 'x', context());
    const declared = sealed.ciphertext.readUInt16BE(1);
    expect(parse(sealed.ciphertext).wrappedKey).toHaveLength(declared);
  });
});

describe('rotation', () => {
  it('re-wraps under the current key and still opens', async () => {
    const keys = LocalKeyManager.ephemeral('local-dev-key/1');
    const sealed = await seal(keys, REFRESH_TOKEN, context());

    const rotated = await rewrap(keys, sealed, context());
    expect(rotated.ciphertext.equals(sealed.ciphertext)).toBe(false);
    await expect(openText(keys, rotated, context())).resolves.toBe(REFRESH_TOKEN);
  });

  it('verifies the context while re-wrapping, so a mis-filed record fails', async () => {
    const keys = LocalKeyManager.ephemeral();
    const sealed = await seal(keys, REFRESH_TOKEN, context());
    await expect(rewrap(keys, sealed, context({ subject: 'wrong' }))).rejects.toThrow(
      DecryptionFailedError,
    );
  });

  it('identifies records sealed under an older key version', async () => {
    const keys = rotatingKeyManager();
    const sealed = await seal(keys, REFRESH_TOKEN, context());
    await expect(needsRewrap(keys, sealed)).resolves.toBe(false);

    keys.rotate();
    await expect(needsRewrap(keys, sealed)).resolves.toBe(true);

    // Still readable: this is the whole point of storing the version.
    await expect(openText(keys, sealed, context())).resolves.toBe(REFRESH_TOKEN);

    const rotated = await rewrap(keys, sealed, context());
    expect(rotated.keyId).toBe('test-key/2');
    await expect(needsRewrap(keys, rotated)).resolves.toBe(false);
  });
});

describe('key manager contract', () => {
  it('rejects a data key of the wrong size', async () => {
    const shortKeys: KeyManager = {
      name: 'ShortKeys',
      async generateDataKey() {
        return {
          plaintext: Buffer.alloc(16),
          wrapped: { ciphertext: Buffer.alloc(8), keyId: 'k/1' },
        };
      },
      async unwrapDataKey() {
        return Buffer.alloc(16);
      },
      async currentKeyId() {
        return 'k/1';
      },
    };
    await expect(seal(shortKeys, 'x', context())).rejects.toThrow(/AES-256-GCM needs 32/);
  });

  it('rejects an unwrapped key of the wrong size', async () => {
    const keys = LocalKeyManager.ephemeral();
    const sealed = await seal(keys, REFRESH_TOKEN, context());
    const broken: KeyManager = {
      name: 'BrokenKeys',
      generateDataKey: keys.generateDataKey.bind(keys),
      async unwrapDataKey() {
        return Buffer.alloc(16);
      },
      currentKeyId: keys.currentKeyId.bind(keys),
    };
    await expect(open(broken, sealed, context())).rejects.toThrow(/expected 32/);
  });
});

/** A local manager whose key version can be advanced, for rotation tests. */
function rotatingKeyManager(): KeyManager & { rotate(): void } {
  const managers = new Map<string, LocalKeyManager>();
  let version = 1;
  const managerFor = (keyId: string): LocalKeyManager => {
    let manager = managers.get(keyId);
    if (!manager) {
      manager = LocalKeyManager.ephemeral(keyId);
      managers.set(keyId, manager);
    }
    return manager;
  };

  return {
    name: 'RotatingKeys',
    rotate() {
      version += 1;
    },
    async generateDataKey() {
      return managerFor(`test-key/${version}`).generateDataKey();
    },
    async unwrapDataKey(wrapped: WrappedKey) {
      return managerFor(wrapped.keyId).unwrapDataKey(wrapped);
    },
    async currentKeyId() {
      return `test-key/${version}`;
    },
  };
}
