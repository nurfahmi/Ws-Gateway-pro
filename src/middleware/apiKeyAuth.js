import prisma from '../lib/prisma.js';

/**
 * Middleware to authenticate API requests using per-device API keys.
 * Expects header: x-api-key: <device_api_key>
 * 
 * For session-specific routes (/api/sessions/:id/...), it also verifies
 * that the API key belongs to the device with that session ID.
 */
export const apiKeyAuth = async (req, res, next) => {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    return res.status(401).json({ error: 'API key required. Set x-api-key header.' });
  }

  try {
    const device = await prisma.device.findUnique({ where: { apiKey } });

    if (!device) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    // Auto-resolve session ID from API key when not provided in URL
    if (!req.params.id) {
      req.params.id = device.sessionId;
    }

    // If session ID IS provided, verify it matches the API key's device
    if (req.params.id !== device.sessionId) {
      return res.status(403).json({ error: 'API key does not match this session' });
    }

    req.device = device;
    next();
  } catch (error) {
    console.error('API key auth error:', error.message);
    res.status(500).json({ error: 'Authentication error' });
  }
};
