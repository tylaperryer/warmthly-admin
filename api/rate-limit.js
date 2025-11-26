// Simple in-memory rate limiter for serverless functions
// Note: For production with multiple instances, consider using Redis or Vercel Edge Config

const rateLimitStore = new Map();

// Clean up old entries periodically
function cleanup() {
  const now = Date.now();
  for (const [key, value] of rateLimitStore.entries()) {
    if (value.resetTime < now) {
      rateLimitStore.delete(key);
    }
  }
}

// Cleanup on each request (simple approach for serverless)
function checkRateLimit(req, options = {}) {
  const {
    windowMs = 15 * 60 * 1000, // 15 minutes
    max = 100, // limit each IP to max requests per windowMs
  } = options;

  // Cleanup old entries
  cleanup();

  // Get client identifier (IP address)
  const identifier = 
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.connection?.remoteAddress ||
    'unknown';

  const key = `${identifier}:${req.url}`;
  const now = Date.now();
  const record = rateLimitStore.get(key);

  if (record) {
    // Check if window has expired
    if (record.resetTime < now) {
      // Reset the record
      record.count = 1;
      record.resetTime = now + windowMs;
      rateLimitStore.set(key, record);
      return { allowed: true, remaining: max - 1, resetTime: record.resetTime };
    }

    // Check if limit exceeded
    if (record.count >= max) {
      return { 
        allowed: false, 
        remaining: 0, 
        resetTime: record.resetTime,
        retryAfter: Math.ceil((record.resetTime - now) / 1000)
      };
    }

    // Increment count
    record.count++;
    rateLimitStore.set(key, record);
    return { allowed: true, remaining: max - record.count, resetTime: record.resetTime };
  } else {
    // Create new record
    rateLimitStore.set(key, {
      count: 1,
      resetTime: now + windowMs,
    });
    return { allowed: true, remaining: max - 1, resetTime: now + windowMs };
  }
}

// Wrapper function for rate limiting in Vercel serverless functions
export function withRateLimit(handler, options = {}) {
  return async (req, res) => {
    const result = checkRateLimit(req, options);
    
    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', options.max || 100);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    res.setHeader('X-RateLimit-Reset', new Date(result.resetTime).toISOString());

    if (!result.allowed) {
      res.setHeader('Retry-After', result.retryAfter);
      return res.status(429).json({ 
        error: options.message || 'Too many requests, please try again later.' 
      });
    }

    return handler(req, res);
  };
}

// Pre-configured rate limit options for different endpoints
export const loginRateLimitOptions = {
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 login attempts per 15 minutes
  message: 'Too many login attempts, please try again later.',
};

export const emailRateLimitOptions = {
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 emails per hour
  message: 'Too many email requests, please try again later.',
};

export const apiRateLimitOptions = {
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per 15 minutes
  message: 'Too many requests, please try again later.',
};

