// /api/get-emails.js
import { createClient } from 'redis';
import jwt from 'jsonwebtoken';
import { withRateLimit, apiRateLimitOptions } from './rate-limit.js';
import logger from './logger.js';

// Create a reusable Redis client (will be reused across invocations in serverless)
let redisClient = null;

async function getRedisClient() {
  logger.log('[get-emails] getRedisClient called');
  
  // Check if we have an existing open connection
  if (redisClient && redisClient.isOpen) {
    logger.log('[get-emails] Reusing existing Redis connection');
    return redisClient;
  }

  // Validate REDIS_URL is configured
  if (!process.env.REDIS_URL) {
    console.error('[get-emails] REDIS_URL is not configured');
    throw new Error('REDIS_URL is not configured');
  }

  logger.log('[get-emails] Creating new Redis connection');
  logger.log('[get-emails] REDIS_URL format:', process.env.REDIS_URL.substring(0, 20) + '...');

  // Create new client
  redisClient = createClient({
    url: process.env.REDIS_URL,
    socket: {
      reconnectStrategy: (retries) => {
        if (retries > 3) {
          console.error('[get-emails] Redis reconnection failed after 3 attempts');
          return new Error('Redis reconnection failed');
        }
        return Math.min(retries * 100, 3000);
      }
    }
  });

  // Error handling
  redisClient.on('error', (err) => {
    console.error('[get-emails] Redis Client Error:', err);
  });

  redisClient.on('connect', () => {
    logger.log('[get-emails] Redis client connecting...');
  });

  redisClient.on('ready', () => {
    logger.log('[get-emails] Redis client ready');
  });

  // Connect if not already connected
  if (!redisClient.isOpen) {
    try {
      logger.log('[get-emails] Attempting to connect to Redis...');
      await redisClient.connect();
      logger.log('[get-emails] Successfully connected to Redis');
    } catch (connectError) {
      console.error('[get-emails] Redis connection failed:', {
        message: connectError.message,
        stack: connectError.stack,
        name: connectError.name
      });
      redisClient = null;
      throw connectError;
    }
  }

  return redisClient;
}

async function getEmailsHandler(req, res) {
  logger.log('[get-emails] Request received:', {
    method: req.method,
    timestamp: new Date().toISOString(),
    hasAuth: !!req.headers.authorization
  });

  // Only allow GET requests
  if (req.method !== 'GET') {
    logger.warn('[get-emails] Method not allowed:', req.method);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger.warn('[get-emails] Missing or invalid authorization header');
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const token = authHeader.split(' ')[1];
    logger.log('[get-emails] Token extracted, length:', token?.length);
    
    // Verify the token
    const jwtSecret = process.env.JWT_SECRET;
    
    if (!jwtSecret) {
      logger.error('[get-emails] JWT_SECRET is not configured');
      return res.status(500).json({ error: 'Authentication system not configured.' });
    }

    logger.log('[get-emails] Verifying JWT token...');
    jwt.verify(token, jwtSecret);
    logger.log('[get-emails] JWT token verified successfully');

    // Get Redis client
    logger.log('[get-emails] Getting Redis client...');
    const client = await getRedisClient();

    // Fetch the 100 most recent emails from the 'emails' list
    logger.log('[get-emails] Fetching emails from Redis list "emails"...');
    let emails = [];
    try {
      emails = await client.lRange('emails', 0, 99);
      logger.log('[get-emails] Successfully fetched', emails.length, 'emails from Redis');
    } catch (kvError) {
      console.error('[get-emails] Error fetching from Redis:', {
        message: kvError.message,
        stack: kvError.stack,
        name: kvError.name,
        code: kvError.code
      });
      
      // If the list doesn't exist, return empty array instead of error
      if (kvError.message && (kvError.message.includes('WRONGTYPE') || kvError.message.includes('no such key'))) {
        logger.log('[get-emails] List does not exist yet, returning empty array');
        emails = [];
      } else {
        throw kvError;
      }
    }

    // The emails are stored as strings, so we need to parse them back into objects
    logger.log('[get-emails] Parsing', emails.length, 'email strings...');
    const parsedEmails = emails
      .map((email, index) => {
        try {
          return JSON.parse(email);
        } catch (e) {
          console.error(`[get-emails] Error parsing email at index ${index}:`, e.message);
          return null;
        }
      })
      .filter(email => email !== null);
    
    logger.log('[get-emails] Successfully parsed', parsedEmails.length, 'emails');
    
    // Reverse to show newest first (since lpush adds to beginning)
    const reversedEmails = parsedEmails.reverse();
    logger.log('[get-emails] Returning', reversedEmails.length, 'emails to client');

    res.status(200).json(reversedEmails);

  } catch (error) {
    // Handle JWT errors
    if (error instanceof jwt.JsonWebTokenError) {
      console.error('[get-emails] JWT verification error:', error.message);
      return res.status(401).json({ error: 'Invalid token.' });
    }
    if (error instanceof jwt.TokenExpiredError) {
      console.error('[get-emails] JWT expired:', error.message);
      return res.status(401).json({ error: 'Token expired. Please log in again.' });
    }
    
    // Log the full error for debugging
    console.error('[get-emails] Unexpected error:', {
      message: error.message,
      stack: error.stack,
      name: error.name,
      code: error.code
    });
    
    // Return more specific error messages
    if (error.message && error.message.includes('REDIS')) {
      return res.status(500).json({ 
        error: 'Database connection error. Please check REDIS_URL configuration.',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to fetch emails.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

// Export handler with rate limiting
export default withRateLimit(getEmailsHandler, apiRateLimitOptions);
