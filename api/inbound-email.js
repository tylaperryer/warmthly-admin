import { createClient } from 'redis';
import { Resend } from 'resend';
import logger from './logger.js';

const resend = new Resend(process.env.RESEND_API_KEY);

// Create a reusable Redis client (will be reused across invocations in serverless)
let redisClient = null;

async function getRedisClient() {
  logger.log('[inbound-email] getRedisClient called');
  
  // Check if we have an existing open connection
  if (redisClient && redisClient.isOpen) {
    logger.log('[inbound-email] Reusing existing Redis connection');
    return redisClient;
  }

  // Validate REDIS_URL is configured
  if (!process.env.REDIS_URL) {
    console.error('[inbound-email] REDIS_URL is not configured');
    throw new Error('REDIS_URL is not configured');
  }

  logger.log('[inbound-email] Creating new Redis connection');
  logger.log('[inbound-email] REDIS_URL format:', process.env.REDIS_URL.substring(0, 20) + '...');

  // Create new client
  redisClient = createClient({
    url: process.env.REDIS_URL,
    socket: {
      reconnectStrategy: (retries) => {
        if (retries > 3) {
          console.error('[inbound-email] Redis reconnection failed after 3 attempts');
          return new Error('Redis reconnection failed');
        }
        return Math.min(retries * 100, 3000);
      }
    }
  });

  // Error handling
  redisClient.on('error', (err) => {
    console.error('[inbound-email] Redis Client Error:', err);
  });

  redisClient.on('connect', () => {
    logger.log('[inbound-email] Redis client connecting...');
  });

  redisClient.on('ready', () => {
    logger.log('[inbound-email] Redis client ready');
  });

  // Connect if not already connected
  if (!redisClient.isOpen) {
    try {
      logger.log('[inbound-email] Attempting to connect to Redis...');
      await redisClient.connect();
      logger.log('[inbound-email] Successfully connected to Redis');
    } catch (connectError) {
      console.error('[inbound-email] Redis connection failed:', {
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

// Helper function to get the raw request body from Vercel
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

export default async function handler(req, res) {
  logger.log('[inbound-email] Request received:', {
    method: req.method,
    timestamp: new Date().toISOString(),
    hasHeaders: !!req.headers
  });

  if (req.method !== 'POST') {
    logger.warn('[inbound-email] Method not allowed:', req.method);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // Get the raw body for signature verification
    logger.log('[inbound-email] Getting raw body...');
    let rawBody;
    try {
      rawBody = await getRawBody(req);
      logger.log('[inbound-email] Raw body received, length:', rawBody.length);
    } catch (bodyError) {
      console.error('[inbound-email] Error getting raw body:', bodyError.message);
      // Fallback: try to use req.body if it exists
      if (req.body) {
        logger.log('[inbound-email] Using req.body as fallback');
        rawBody = Buffer.from(JSON.stringify(req.body));
      } else {
        throw new Error('Could not get request body');
      }
    }
    
    // Get the signature headers from the request
    const signature = req.headers['svix-signature'];
    const id = req.headers['svix-id'];
    const timestamp = req.headers['svix-timestamp'];

    logger.log('[inbound-email] Webhook headers:', {
      hasSignature: !!signature,
      hasId: !!id,
      hasTimestamp: !!timestamp
    });

    // Verify the webhook signature - required in production
    const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;
    
    // Require webhook secret in production
    if (!webhookSecret) {
      console.error('[inbound-email] RESEND_WEBHOOK_SECRET is required in production');
      return res.status(500).json({ error: 'Webhook verification not configured' });
    }

    let event;
    logger.log('[inbound-email] Webhook secret found, verifying signature...');
    try {
      // Verify the webhook signature
      event = resend.webhooks.verify({
        body: rawBody,
        headers: {
          'svix-id': id,
          'svix-timestamp': timestamp,
          'svix-signature': signature,
        },
        secret: webhookSecret,
      });
      logger.log('[inbound-email] Webhook signature verified successfully');
    } catch (verifyError) {
      console.error('[inbound-email] Webhook verification failed:', {
        message: verifyError.message,
        stack: verifyError.stack
      });
      return res.status(401).json({ error: 'Webhook verification failed.' });
    }

    // Log the incoming webhook for debugging
    logger.log('[inbound-email] Webhook event:', {
      type: event?.type,
      hasData: !!event?.data,
      timestamp: new Date().toISOString()
    });

    if (event.type === 'email.received') {
      const emailData = event.data;
      
      logger.log('[inbound-email] Processing email.received event');
      
      // Validate required fields
      if (!emailData) {
        console.error('[inbound-email] Email data is missing');
        return res.status(400).json({ error: 'Email data is missing' });
      }

      logger.log('[inbound-email] Email data:', {
        hasId: !!emailData.email_id,
        hasFrom: !!emailData.from,
        hasTo: !!emailData.to,
        hasSubject: !!emailData.subject
      });

      // Get Redis client
      logger.log('[inbound-email] Getting Redis client...');
      const client = await getRedisClient();

      // Create a simple object for the email
      const emailToStore = {
        id: emailData.email_id || `email-${Date.now()}`,
        from: emailData.from || 'Unknown',
        to: emailData.to || 'Unknown',
        subject: emailData.subject || '(No Subject)',
        receivedAt: emailData.created_at || new Date().toISOString(),
      };

      logger.log('[inbound-email] Email to store:', {
        id: emailToStore.id,
        from: emailToStore.from,
        to: emailToStore.to,
        subject: emailToStore.subject.substring(0, 50)
      });

      // Save the email to a list in the database.
      // We use 'lPush' to add it to the beginning of a list called 'emails'.
      try {
        logger.log('[inbound-email] Saving email to Redis list "emails"...');
        const emailJson = JSON.stringify(emailToStore);
        const result = await client.lPush('emails', emailJson);
        logger.log('[inbound-email] Email saved successfully, list length:', result);
        
        logger.log('[inbound-email] Email saved to Redis:', {
          id: emailToStore.id,
          from: emailToStore.from,
          to: emailToStore.to,
          subject: emailToStore.subject
        });
      } catch (saveError) {
        console.error('[inbound-email] Error saving email to Redis:', {
          message: saveError.message,
          stack: saveError.stack,
          name: saveError.name,
          code: saveError.code
        });
        throw saveError;
      }
    } else {
      logger.log('[inbound-email] Webhook event type not handled:', event.type);
    }

    res.status(200).json({ message: 'Webhook processed successfully.' });

  } catch (error) {
    console.error('[inbound-email] Error processing webhook:', {
      message: error.message,
      stack: error.stack,
      name: error.name,
      code: error.code
    });
    return res.status(500).json({ 
      error: 'Error processing webhook.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}
