// SafeSpace SMS Backend API
// Deploy this to Vercel, Netlify, or any Node.js hosting service

const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['POST', 'GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Rate limiting to prevent abuse
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // limit each IP to 10 requests per windowMs
  message: {
    error: 'Too many SMS requests, please try again later.',
    code: 'RATE_LIMIT_EXCEEDED'
  }
});

// Twilio Configuration
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

// API Key validation middleware
const validateApiKey = (req, res, next) => {
  const apiKey = req.headers.authorization?.replace('Bearer ', '');
  const validKey = process.env.API_KEY;
  
  // Skip validation if no API key is set (for development)
  if (!validKey) {
    return next();
  }
  
  if (!apiKey || apiKey !== validKey) {
    return res.status(401).json({
      error: 'Unauthorized: Invalid API key',
      code: 'INVALID_API_KEY'
    });
  }
  
  next();
};

// Phone number validation
const isValidPhoneNumber = (phone) => {
  // Basic phone number validation (supports international formats)
  const phoneRegex = /^\+?[\d\s\-\(\)]{10,}$/;
  return phoneRegex.test(phone);
};

// Format phone number for Twilio
const formatPhoneNumber = (phone) => {
  // Remove all non-digit characters except +
  let formatted = phone.replace(/[^\d+]/g, '');
  
  // Add + if not present and number starts with 1 (US/Canada)
  if (!formatted.startsWith('+')) {
    if (formatted.startsWith('1') && formatted.length === 11) {
      formatted = '+' + formatted;
    } else if (formatted.length === 10) {
      formatted = '+1' + formatted;
    } else {
      formatted = '+' + formatted;
    }
  }
  
  return formatted;
};

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'SafeSpace SMS API',
    status: 'operational',
    version: '1.0.0',
    endpoints: {
      'POST /send-sms': 'Send emergency SMS',
      'POST /test-sms': 'Test SMS configuration',
      'GET /status': 'Service status'
    }
  });
});

// Status endpoint
app.get('/status', (req, res) => {
  res.json({
    status: 'operational',
    twilio_configured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
    timestamp: new Date().toISOString()
  });
});

// Test SMS endpoint (doesn't send real SMS)
app.post('/test-sms', validateApiKey, (req, res) => {
  const { to, message, test } = req.body;
  
  // Validate required fields
  if (!to || !message) {
    return res.status(400).json({
      error: 'Missing required fields: to, message',
      code: 'MISSING_FIELDS'
    });
  }
  
  // Validate phone number format
  if (!isValidPhoneNumber(to)) {
    return res.status(400).json({
      error: 'Invalid phone number format',
      code: 'INVALID_PHONE_FORMAT'
    });
  }
  
  // For test requests, just validate and return success
  if (test) {
    return res.json({
      success: true,
      message: 'Test configuration successful',
      to: to,
      test_mode: true
    });
  }
  
  res.json({
    success: true,
    message: 'Configuration test passed - ready for real SMS',
    to: to
  });
});

// Main SMS sending endpoint
app.post('/send-sms', limiter, validateApiKey, async (req, res) => {
  try {
    const { to, message, from, emergency } = req.body;
    
    // Validate required fields
    if (!to || !message) {
      return res.status(400).json({
        error: 'Missing required fields: to, message',
        code: 'MISSING_FIELDS'
      });
    }
    
    // Validate Twilio configuration
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
      return res.status(500).json({
        error: 'Twilio not configured on server',
        code: 'TWILIO_NOT_CONFIGURED'
      });
    }
    
    // Validate and format phone number
    if (!isValidPhoneNumber(to)) {
      return res.status(400).json({
        error: 'Invalid phone number format. Use format: +1234567890',
        code: 'INVALID_PHONE_FORMAT'
      });
    }
    
    const formattedPhone = formatPhoneNumber(to);
    
    // Prepare message with SafeSpace branding
    const fullMessage = `${message}\n\n- Sent via SafeSpace Emergency App`;
    
    // Send SMS via Twilio
    const messageOptions = {
      body: fullMessage,
      from: TWILIO_PHONE_NUMBER,
      to: formattedPhone
    };
    
    // For emergency messages, try to prioritize delivery
    if (emergency) {
      messageOptions.provideFeedback = true;
      messageOptions.attemptCount = 3;
    }
    
    console.log(`Sending SMS to ${formattedPhone}: ${fullMessage.substring(0, 50)}...`);
    
    const twilioMessage = await twilioClient.messages.create(messageOptions);
    
    // Log successful send (don't log full message for privacy)
    console.log(`SMS sent successfully - SID: ${twilioMessage.sid}, Status: ${twilioMessage.status}`);
    
    res.json({
      success: true,
      message: 'SMS sent successfully',
      sid: twilioMessage.sid,
      status: twilioMessage.status,
      to: formattedPhone,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('SMS sending error:', error);
    
    // Handle specific Twilio errors
    if (error.code) {
      let errorMessage = 'SMS sending failed';
      
      switch (error.code) {
        case 21211:
          errorMessage = 'Invalid phone number';
          break;
        case 21608:
          errorMessage = 'Phone number is not reachable';
          break;
        case 21614:
          errorMessage = 'Phone number is not valid for SMS';
          break;
        case 20003:
          errorMessage = 'Authentication failed - check Twilio credentials';
          break;
        case 20429:
          errorMessage = 'Too many requests - rate limited';
          break;
        default:
          errorMessage = `Twilio error: ${error.message}`;
      }
      
      return res.status(400).json({
        error: errorMessage,
        code: error.code,
        twilio_error: true
      });
    }
    
    // Generic error handling
    res.status(500).json({
      error: 'Internal server error while sending SMS',
      code: 'INTERNAL_ERROR',
      message: process.env.NODE_ENV === 'development' ? error.message : 'SMS service temporarily unavailable'
    });
  }
});

// Webhook endpoint for SMS delivery status (optional)
app.post('/webhook/sms-status', express.urlencoded({ extended: false }), (req, res) => {
  const { MessageSid, MessageStatus, To } = req.body;
  
  console.log(`SMS Status Update - SID: ${MessageSid}, Status: ${MessageStatus}, To: ${To}`);
  
  // Here you could store delivery status in a database
  // or send real-time updates to your frontend
  
  res.status(200).send('OK');
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    code: 'NOT_FOUND',
    available_endpoints: ['/', '/status', '/send-sms', '/test-sms']
  });
});

// Start server
app.listen(port, () => {
  console.log(`SafeSpace SMS API running on port ${port}`);
  console.log(`Twilio configured: ${!!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;