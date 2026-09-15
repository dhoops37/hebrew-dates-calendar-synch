/**
 * Envelope encryption contracts.
 *
 * The shape is deliberately narrow. A key manager can *wrap* and *unwrap* a
 * short data key and nothing else; it never sees a refresh token, and it is not
 * asked to encrypt arbitrary plaintext. That keeps the KMS call small and
 * cheap, keeps the token's bulk encryption local (AES-256-GCM), and means
 * swapping Google Cloud KMS for anything else touches one file.
 */

/** A wrapped data key plus the key version that wrapped it. */
export interface WrappedKey {
  /** Ciphertext of the 32-byte data key, opaque to this package. */
  readonly ciphertext: Buffer;
  /**
   * Which key version wrapped it, e.g. a full KMS crypto key version name.
   *
   * Stored beside the record so rotation can re-wrap the data key without ever
   * reading the protected plaintext back, and so a record encrypted under a
   * retired key is still readable.
   */
  readonly keyId: string;
}

/**
 * A key manager: wraps and unwraps data keys.
 *
 * `keyId` on unwrap is the value recorded at encryption time, not the current
 * primary version. Passing it explicitly is what makes decryption survive
 * rotation; resolving "the current key" at decrypt time would break every row
 * written before the rotation.
 */
export interface KeyManager {
  /** A stable, loggable name for this manager, used in errors. */
  readonly name: string;
  /** Generate a fresh data key and return it both raw and wrapped. */
  generateDataKey(): Promise<{ plaintext: Buffer; wrapped: WrappedKey }>;
  /** Recover a data key wrapped earlier. */
  unwrapDataKey(wrapped: WrappedKey): Promise<Buffer>;
  /** The key version new writes should use, for detecting stale records. */
  currentKeyId(): Promise<string>;
}

/**
 * A sealed secret, as stored.
 *
 * `ciphertext` is self-describing — it carries its own version byte, the
 * wrapped data key, the nonce and the auth tag — so a row needs only this
 * blob and the `keyId`. The two are kept separate because the database stores
 * them in separate columns (`encrypted_refresh_token`, `encryption_key_id`),
 * and `keyId` must be queryable to find rows needing re-wrapping.
 */
export interface SealedSecret {
  readonly ciphertext: Buffer;
  readonly keyId: string;
}

export class DecryptionFailedError extends Error {}
export class MalformedCiphertextError extends Error {}
export class KeyManagerError extends Error {}
