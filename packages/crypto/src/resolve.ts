/**
 * Choosing a key manager from the environment.
 *
 * One function, so the decision is made in exactly one place and the rule is
 * explicit: **KMS if it is configured, local only if it is not, and never local
 * in production.** Leaving each call site to decide is how a deployment ends up
 * quietly running on a development key.
 */
import { KmsKeyManager } from './kms-key-manager';
import { LocalKeyManager, assertNotProduction } from './local-key-manager';
import { KeyManagerError, type KeyManager } from './types';

export interface ResolvedKeyManager {
  keys: KeyManager;
  /** Which backend was chosen, for a startup log line and the health check. */
  backend: 'kms' | 'local';
  /** Shown in the dashboard's diagnostics; never includes key material. */
  description: string;
}

export function resolveKeyManager(
  environment: NodeJS.ProcessEnv = process.env,
): ResolvedKeyManager {
  if (environment.KMS_KEY_NAME) {
    return {
      keys: KmsKeyManager.fromEnvironment(environment),
      backend: 'kms',
      description: `Google Cloud KMS (${environment.KMS_KEY_NAME})`,
    };
  }

  // Not merely a warning: a production deployment with no KMS key configured
  // must fail to start rather than seal real users' refresh tokens under an
  // environment variable.
  assertNotProduction(environment);

  if (!environment.LOCAL_ENVELOPE_MASTER_KEY) {
    throw new KeyManagerError(
      'No key manager is configured. Set KMS_KEY_NAME to use Google Cloud KMS, or ' +
        'LOCAL_ENVELOPE_MASTER_KEY (base64, 32 bytes) for local development: ' +
        '`openssl rand -base64 32`.',
    );
  }

  return {
    keys: LocalKeyManager.fromEnvironment(environment),
    backend: 'local',
    description: 'Local development master key (NOT for production)',
  };
}
