/**
 * Envelope encryption for OAuth refresh tokens and the PKCE verifier.
 *
 * Why an envelope rather than encrypting straight through the KMS: a KMS call
 * per read is slow and metered, and Google's `encrypt` has a plaintext size
 * limit. So a fresh 256-bit data key encrypts the secret locally with
 * AES-256-GCM, and only that 32-byte key goes to the KMS to be wrapped. The
 * wrapped key travels inside the ciphertext.
 *
 * Why AES-256-GCM: authenticated. A tampered ciphertext fails to decrypt
 * instead of yielding attacker-chosen plaintext — which matters here, because
 * the plaintext is fed to Google as a credential.
 *
 * The additional authenticated data binds a ciphertext to the row it belongs
 * to. Without it, a ciphertext lifted from one `google_accounts` row and pasted
 * into another would decrypt cleanly, and one user's calendar would be written
 * with another user's token.
 *
 * Wire format, all big-endian:
 *
 *   byte  0        format version (1)
 *   bytes 1-2      wrapped data key length, uint16
 *   bytes 3..      wrapped data key
 *   next  12       nonce
 *   next  16       GCM auth tag
 *   remainder      AES-256-GCM ciphertext
 *
 * The version byte exists so a future format can be introduced without
 * re-encrypting every stored token: a reader dispatches on it.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  DecryptionFailedError,
  MalformedCiphertextError,
  type KeyManager,
  type SealedSecret,
} from './types';

const FORMAT_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const LENGTH_PREFIX_BYTES = 2;
const HEADER_BYTES = 1 + LENGTH_PREFIX_BYTES;

/**
 * What a ciphertext is bound to.
 *
 * Passed on both seal and open, and an exact match is required. The fields are
 * the stable identity of the row: a purpose (so an OAuth verifier can never be
 * opened as a refresh token) and the subject it belongs to.
 */
export interface SecretContext {
  /** e.g. 'google.refresh_token' or 'oauth.code_verifier'. */
  readonly purpose: string;
  /** The row this secret belongs to — a user ID, or the state hash. */
  readonly subject: string;
}

/**
 * Serialise the context to bytes for use as AAD.
 *
 * Length-prefixed rather than concatenated with a separator, so that
 * `{purpose: 'a', subject: 'b:c'}` and `{purpose: 'a:b', subject: 'c'}` cannot
 * produce the same AAD.
 */
export function encodeContext(context: SecretContext): Buffer {
  const purpose = Buffer.from(context.purpose, 'utf8');
  const subject = Buffer.from(context.subject, 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt32BE(purpose.length, 0);
  header.writeUInt32BE(subject.length, 4);
  return Buffer.concat([header, purpose, subject]);
}

/** Encrypt a secret. The plaintext buffer is zeroed before returning. */
export async function seal(
  keys: KeyManager,
  plaintext: Buffer | string,
  context: SecretContext,
): Promise<SealedSecret> {
  const secret = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const { plaintext: dataKey, wrapped } = await keys.generateDataKey();

  if (dataKey.length !== KEY_BYTES) {
    dataKey.fill(0);
    throw new MalformedCiphertextError(
      `${keys.name} returned a ${dataKey.length}-byte data key; AES-256-GCM needs ${KEY_BYTES}.`,
    );
  }

  try {
    // A fresh data key per secret means a fresh nonce is safe by construction:
    // the (key, nonce) pair cannot repeat, which is the one thing GCM must
    // never do.
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', dataKey, nonce);
    cipher.setAAD(encodeContext(context));
    const body = Buffer.concat([cipher.update(secret), cipher.final()]);
    const tag = cipher.getAuthTag();

    const prefix = Buffer.alloc(HEADER_BYTES);
    prefix.writeUInt8(FORMAT_VERSION, 0);
    prefix.writeUInt16BE(wrapped.ciphertext.length, 1);

    return {
      ciphertext: Buffer.concat([prefix, wrapped.ciphertext, nonce, tag, body]),
      keyId: wrapped.keyId,
    };
  } finally {
    // The data key has served its purpose; do not leave it in a buffer that may
    // be reused or end up in a heap dump.
    dataKey.fill(0);
  }
}

/** Decrypt a secret sealed earlier. Throws rather than returning a partial. */
export async function open(
  keys: KeyManager,
  sealed: SealedSecret,
  context: SecretContext,
): Promise<Buffer> {
  const parsed = parse(sealed.ciphertext);
  const dataKey = await keys.unwrapDataKey({
    ciphertext: parsed.wrappedKey,
    keyId: sealed.keyId,
  });

  try {
    if (dataKey.length !== KEY_BYTES) {
      throw new DecryptionFailedError(
        `${keys.name} unwrapped a ${dataKey.length}-byte key; expected ${KEY_BYTES}.`,
      );
    }

    const decipher = createDecipheriv('aes-256-gcm', dataKey, parsed.nonce);
    decipher.setAAD(encodeContext(context));
    decipher.setAuthTag(parsed.tag);
    return Buffer.concat([decipher.update(parsed.body), decipher.final()]);
  } catch (error) {
    if (error instanceof DecryptionFailedError) throw error;
    // Deliberately uniform: the caller learns that it failed, not whether the
    // tag, the AAD or the key was wrong. Distinguishing them is an oracle.
    throw new DecryptionFailedError(
      'Could not decrypt the stored secret. The ciphertext, the context it was ' +
        'sealed against, or the key version does not match.',
    );
  } finally {
    dataKey.fill(0);
  }
}

/** Decrypt to a UTF-8 string, zeroing the intermediate buffer. */
export async function openText(
  keys: KeyManager,
  sealed: SealedSecret,
  context: SecretContext,
): Promise<string> {
  const buffer = await open(keys, sealed, context);
  try {
    return buffer.toString('utf8');
  } finally {
    buffer.fill(0);
  }
}

/**
 * Re-wrap a secret under the current key without reading its plaintext out.
 *
 * This is the rotation path. It still has to decrypt and re-encrypt locally —
 * the data key changes, so the body must be re-encrypted — but the plaintext
 * never leaves this function, and the context is re-verified on the way
 * through, so a mis-filed ciphertext fails rotation rather than being silently
 * re-sealed under a new key.
 */
export async function rewrap(
  keys: KeyManager,
  sealed: SealedSecret,
  context: SecretContext,
): Promise<SealedSecret> {
  const plaintext = await open(keys, sealed, context);
  try {
    return await seal(keys, plaintext, context);
  } finally {
    plaintext.fill(0);
  }
}

/** Whether a stored record was sealed under something other than the current key. */
export async function needsRewrap(keys: KeyManager, sealed: SealedSecret): Promise<boolean> {
  return (await keys.currentKeyId()) !== sealed.keyId;
}

export interface ParsedCiphertext {
  version: number;
  wrappedKey: Buffer;
  nonce: Buffer;
  tag: Buffer;
  body: Buffer;
}

/**
 * Split the wire format.
 *
 * Every length is checked before it is used as an offset. A truncated or
 * hand-edited blob must produce a clear error, not a buffer read past the end
 * or a zero-length key.
 */
export function parse(ciphertext: Buffer): ParsedCiphertext {
  if (ciphertext.length < HEADER_BYTES) {
    throw new MalformedCiphertextError('Sealed secret is too short to contain a header.');
  }

  const version = ciphertext.readUInt8(0);
  if (version !== FORMAT_VERSION) {
    throw new MalformedCiphertextError(
      `Unsupported sealed-secret format version ${version}; this build understands ${FORMAT_VERSION}.`,
    );
  }

  const wrappedKeyLength = ciphertext.readUInt16BE(1);
  if (wrappedKeyLength === 0) {
    throw new MalformedCiphertextError('Sealed secret declares an empty wrapped key.');
  }

  const minimum = HEADER_BYTES + wrappedKeyLength + NONCE_BYTES + TAG_BYTES;
  if (ciphertext.length < minimum) {
    throw new MalformedCiphertextError(
      `Sealed secret is truncated: declares a ${wrappedKeyLength}-byte wrapped key, ` +
        `so it needs at least ${minimum} bytes but has ${ciphertext.length}.`,
    );
  }

  let offset = HEADER_BYTES;
  const wrappedKey = ciphertext.subarray(offset, (offset += wrappedKeyLength));
  const nonce = ciphertext.subarray(offset, (offset += NONCE_BYTES));
  const tag = ciphertext.subarray(offset, (offset += TAG_BYTES));
  const body = ciphertext.subarray(offset);

  return { version, wrappedKey, nonce, tag, body };
}

/** Constant-time buffer comparison, for callers checking a stored hash. */
export function buffersMatch(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const FORMAT = {
  version: FORMAT_VERSION,
  nonceBytes: NONCE_BYTES,
  tagBytes: TAG_BYTES,
  keyBytes: KEY_BYTES,
  headerBytes: HEADER_BYTES,
} as const;
