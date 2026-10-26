/**
 * Retries a request that failed at the socket level (ECONNRESET / socket hang up) before any HTTP response
 * arrived. Such resets come from reusing an idle keep-alive connection the edge has already closed; they say
 * nothing about the app. A real HTTP status is never retried, so assertions on status codes stay strict.
 */
const SOCKET_RESET = /ECONNRESET|socket hang up/;

export async function retryOnSocketReset<T>(send: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (err) {
      const transient = SOCKET_RESET.test(err instanceof Error ? err.message : String(err));
      if (!transient || attempt >= attempts) throw err;
    }
  }
}
