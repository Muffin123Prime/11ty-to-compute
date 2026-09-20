'use strict';

/**
 * Neural OS error taxonomy.
 *
 * Every failure in this system is one of these. The HTTP layer maps `status`
 * straight onto the response code, and the UI renders `code` + `message`.
 * We never swallow an error and we never substitute a plausible-looking
 * success for a real failure -- especially not for model output.
 */

class NeuralError extends Error {
  /**
   * @param {string} code    stable machine-readable identifier, SCREAMING_SNAKE
   * @param {string} message human-readable, safe to show in the UI
   * @param {object} [opts]
   * @param {number} [opts.status=500] HTTP status to use at the boundary
   * @param {object} [opts.details]    structured extra context
   * @param {Error}  [opts.cause]
   */
  constructor(code, message, opts = {}) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'NeuralError';
    this.code = code;
    this.status = opts.status ?? 500;
    this.details = opts.details ?? null;
  }

  toJSON() {
    return {
      error: { code: this.code, message: this.message, details: this.details },
    };
  }
}

/** Input the caller sent is malformed or fails schema validation. */
class ValidationError extends NeuralError {
  constructor(message, details) {
    super('VALIDATION_FAILED', message, { status: 400, details });
    this.name = 'ValidationError';
  }
}

/** A record, route or resource does not exist. */
class NotFoundError extends NeuralError {
  constructor(what) {
    super('NOT_FOUND', `${what} not found`, { status: 404 });
    this.name = 'NotFoundError';
  }
}

/**
 * A capability was required and not granted. This is the single error used by
 * the agent permission system and by the network gate for policy denials.
 */
class PermissionError extends NeuralError {
  constructor(message, details) {
    super('PERMISSION_DENIED', message, { status: 403, details });
    this.name = 'PermissionError';
  }
}

/**
 * An outbound connection was blocked by the egress policy. Distinct from
 * PermissionError so the UI can offer the "grant once" affordance.
 */
class NetworkBlockedError extends NeuralError {
  constructor(message, details) {
    super('NETWORK_BLOCKED', message, { status: 403, details });
    this.name = 'NetworkBlockedError';
  }
}

/**
 * No usable local model backend is reachable. Thrown instead of inventing a
 * response. The UI turns this into actionable setup instructions.
 */
class NoModelError extends NeuralError {
  constructor(message, details) {
    super('NO_MODEL_AVAILABLE', message, { status: 503, details });
    this.name = 'NoModelError';
  }
}

/** A configured model backend was reachable but failed the request. */
class ModelError extends NeuralError {
  constructor(message, details) {
    super('MODEL_ERROR', message, { status: 502, details });
    this.name = 'ModelError';
  }
}

/** The on-disk vault is unreadable, corrupt, or locked by another process. */
class StorageError extends NeuralError {
  constructor(message, details) {
    super('STORAGE_ERROR', message, { status: 500, details });
    this.name = 'StorageError';
  }
}

/** The vault is encrypted and no valid passphrase has been supplied yet. */
class LockedError extends NeuralError {
  constructor(message = 'Vault is locked') {
    super('VAULT_LOCKED', message, { status: 423 });
    this.name = 'LockedError';
  }
}

/** Caller is not authenticated (only ever relevant when sharing is enabled). */
class AuthError extends NeuralError {
  constructor(message = 'Authentication required') {
    super('UNAUTHORIZED', message, { status: 401 });
    this.name = 'AuthError';
  }
}

/** The user explicitly denied an approval request, or it timed out. */
class ApprovalDeniedError extends NeuralError {
  constructor(message, details) {
    super('APPROVAL_DENIED', message, { status: 403, details });
    this.name = 'ApprovalDeniedError';
  }
}

/** Operation aborted (user pressed stop, run cancelled, server shutting down). */
class AbortedError extends NeuralError {
  constructor(message = 'Operation aborted') {
    super('ABORTED', message, { status: 499 });
    this.name = 'AbortedError';
  }
}

/** Normalise anything thrown into a NeuralError without losing information. */
function asNeuralError(err) {
  if (err instanceof NeuralError) return err;
  if (err && err.name === 'AbortError') return new AbortedError();
  const message = err && err.message ? err.message : String(err);
  const wrapped = new NeuralError('INTERNAL_ERROR', message, { cause: err });
  if (err && err.stack) wrapped.stack = err.stack;
  return wrapped;
}

module.exports = {
  NeuralError,
  ValidationError,
  NotFoundError,
  PermissionError,
  NetworkBlockedError,
  NoModelError,
  ModelError,
  StorageError,
  LockedError,
  AuthError,
  ApprovalDeniedError,
  AbortedError,
  asNeuralError,
};
