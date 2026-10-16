/**
 * Run `op`, retrying with exponential backoff (250 ms, 500 ms, ...).
 *
 * Boot-time job rebuilds use it so a transient MongoDB failure does not
 * leave a guild's scheduled work missing for the life of the process.
 */
export const retryWithBackoff = async <T>(op: () => Promise<T>, attempts = 3): Promise<T> => {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
  }
  throw lastErr;
};
