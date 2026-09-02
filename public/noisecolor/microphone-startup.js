export class MicrophoneStartupError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "MicrophoneStartupError";
    this.code = code;
  }
}

function cancelledError() {
  return new MicrophoneStartupError("Microphone startup was cancelled.", "MICROPHONE_STARTUP_CANCELLED");
}

export function isMicrophoneStartupCancellation(error) {
  return error?.code === "MICROPHONE_STARTUP_CANCELLED";
}

export function isMicrophoneStartupConflict(error) {
  return error?.code === "MICROPHONE_STARTUP_IN_PROGRESS";
}

export class MicrophoneStartupLock {
  constructor() {
    this.current = null;
  }

  get pending() {
    return Boolean(this.current);
  }

  async run(operation) {
    if (this.current) {
      throw new MicrophoneStartupError("A microphone startup attempt is already in progress.", "MICROPHONE_STARTUP_IN_PROGRESS");
    }
    const attempt = {
      cancelled: false,
      committed: false,
      cleanups: [],
      cleanupPromise: null,
    };
    this.current = attempt;

    const cleanup = async () => {
      if (attempt.cleanupPromise) return attempt.cleanupPromise;
      attempt.cleanupPromise = (async () => {
        const cleanups = attempt.cleanups.splice(0).reverse();
        for (const release of cleanups) {
          try { await release(); } catch { /* every remaining resource still needs a release attempt */ }
        }
      })();
      return attempt.cleanupPromise;
    };

    const scope = {
      checkpoint() {
        if (attempt.cancelled) throw cancelledError();
      },
      async track(resource, release) {
        if (!resource) return resource;
        if (attempt.cancelled) {
          try { await release(resource); } catch { /* best-effort cancellation cleanup */ }
          throw cancelledError();
        }
        attempt.cleanups.push(() => release(resource));
        return resource;
      },
      commit() {
        if (attempt.cancelled) throw cancelledError();
        attempt.committed = true;
        attempt.cleanups.length = 0;
      },
    };

    const promise = (async () => {
      try {
        const result = await operation(scope);
        scope.checkpoint();
        if (!attempt.committed) throw new MicrophoneStartupError("Microphone startup did not transfer resource ownership.", "MICROPHONE_STARTUP_UNCOMMITTED");
        return result;
      } catch (error) {
        if (attempt.cancelled && !isMicrophoneStartupCancellation(error)) throw cancelledError();
        throw error;
      } finally {
        if (!attempt.committed) await cleanup();
        if (this.current === attempt) this.current = null;
      }
    })();
    attempt.promise = promise;
    return promise;
  }

  async cancel() {
    const attempt = this.current;
    if (!attempt || attempt.committed) return false;
    attempt.cancelled = true;
    const cleanups = attempt.cleanups.splice(0).reverse();
    for (const release of cleanups) {
      try { await release(); } catch { /* every remaining resource still needs a release attempt */ }
    }
    return true;
  }
}
