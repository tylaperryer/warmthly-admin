import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { withRateLimit, loginRateLimitOptions } from './rate-limit.js';

// Constant-time comparison to prevent timing attacks
function constantTimeCompare(a, b) {
  // Handle null/undefined cases
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch (error) {
    // If comparison fails for any reason, return false
    return false;
  }
}

async function loginHandler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    return res.status(500).json({ error: 'Admin password not configured.' });
  }

  // Use constant-time comparison to prevent timing attacks
  if (constantTimeCompare(password || '', adminPassword)) {
    // Password is correct, create a JWT
    const jwtSecret = process.env.JWT_SECRET;
    
    if (!jwtSecret) {
      console.error('JWT_SECRET is not configured');
      return res.status(500).json({ error: 'Authentication system not configured.' });
    }

    const token = jwt.sign(
      { user: 'admin' }, // Payload
      jwtSecret, // Secret key for signing
      { expiresIn: '8h' } // Token expires in 8 hours
    );

    res.status(200).json({ token });
  } else {
    res.status(401).json({ error: 'Incorrect password' });
  }
}

// Export handler with rate limiting
export default withRateLimit(loginHandler, loginRateLimitOptions);
