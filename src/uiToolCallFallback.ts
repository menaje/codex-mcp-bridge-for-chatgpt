export type UiToolCallAttempt<T> = () => T | PromiseLike<T>;

export type UiToolCallFallbackOptions = {
  standardTimeoutMs: number;
  compatibilityTimeoutMs: number;
  timeoutMessage: string;
  shouldFallback?: (error: unknown) => boolean;
};

/**
 * Bounds a host bridge attempt, including a thenable that never settles.
 *
 * This function is serialized into the self-contained Dashboard HTML. Keep it
 * free of module-local dependencies.
 */
export function withUiToolCallTimeout<T>(
  attempt: UiToolCallAttempt<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    Promise.resolve()
      .then(attempt)
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      );
  });
}

/**
 * Uses the standard MCP Apps call path first, then the ChatGPT compatibility
 * alias only when the standard transport or initialization attempt fails.
 */
export async function callUiToolWithFallback<T>(
  standardAttempt: UiToolCallAttempt<T>,
  compatibilityAttempt: UiToolCallAttempt<T> | undefined,
  options: UiToolCallFallbackOptions
): Promise<T> {
  let standardError: unknown;
  try {
    return await withUiToolCallTimeout(
      standardAttempt,
      options.standardTimeoutMs,
      options.timeoutMessage
    );
  } catch (error) {
    standardError = error;
  }

  if (!compatibilityAttempt || options.shouldFallback?.(standardError) === false) {
    throw standardError;
  }
  return withUiToolCallTimeout(
    compatibilityAttempt,
    options.compatibilityTimeoutMs,
    options.timeoutMessage
  );
}
