/**
 * Retry with exponential backoff
 * @param {Function} fn - async function to retry
 * @param {object} opts - { maxRetries, baseDelay, label }
 * @returns {Promise<*>}
 */
async function withRetry(fn, opts = {}) {
  const maxRetries = opts.maxRetries || 3;
  const baseDelay = opts.baseDelay || 1000;
  const label = opts.label || 'operation';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) {
        console.error(`[Retry] ${label} falló después de ${maxRetries + 1} intentos: ${err.message}`);
        throw err;
      }
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 500;
      console.warn(`[Retry] ${label} intento ${attempt + 1}/${maxRetries + 1} falló, reintentando en ${Math.round(delay)}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

/**
 * Fetch with timeout using AbortController
 * @param {string} url
 * @param {object} options - fetch options + timeoutMs
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}) {
  const timeoutMs = options.timeoutMs || 10000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Timeout después de ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = { withRetry, fetchWithTimeout };
