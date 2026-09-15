/**
 * @hebrew-dates/crypto — envelope encryption for stored credentials.
 *
 * Nothing in this package knows what it is protecting. It seals and opens
 * opaque bytes against a key manager, and the callers supply the context that
 * binds a ciphertext to its row.
 */
export * from './types';
export * from './envelope';
export * from './local-key-manager';
export * from './kms-key-manager';
export * from './resolve';
