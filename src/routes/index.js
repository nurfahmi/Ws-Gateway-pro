import { Router } from 'express';
import { requireAuth, requireRole, guestOnly } from '../middleware/auth.js';
import * as authCtrl from '../controllers/authController.js';
import * as dashCtrl from '../controllers/dashboardController.js';
import * as userCtrl from '../controllers/userController.js';
import * as deviceCtrl from '../controllers/deviceController.js';
import * as msgCtrl from '../controllers/messageController.js';
import * as chatCtrl from '../controllers/chatController.js';
import * as analyticsCtrl from '../controllers/analyticsController.js';
import * as monitorCtrl from '../controllers/monitorController.js';
import * as apiDocsCtrl from '../controllers/apiDocsController.js';
import * as settingsCtrl from '../controllers/settingsController.js';
import { getSettings } from '../controllers/settingsController.js';
import * as setupCtrl from '../controllers/setupController.js';

const router = Router();

// Inject site settings into all views
router.use(async (req, res, next) => {
  try {
    res.locals.siteSettings = await getSettings();
  } catch (e) {
    res.locals.siteSettings = {};
  }
  next();
});

// One-time setup
router.get('/setup/:token', setupCtrl.setupPage);
router.post('/setup/:token', setupCtrl.setupPost);

// Auth
router.get('/login', guestOnly, authCtrl.loginPage);
router.post('/login', guestOnly, authCtrl.loginPost);
router.get('/logout', authCtrl.logout);

// Root redirect
router.get('/', (req, res) => res.redirect('/dashboard'));

// Dashboard
router.get('/dashboard', requireAuth, dashCtrl.index);

// Users (superadmin + manager)
router.get('/users', requireAuth, requireRole('superadmin', 'manager'), userCtrl.index);
router.get('/users/create', requireAuth, requireRole('superadmin', 'manager'), userCtrl.createPage);
router.post('/users/create', requireAuth, requireRole('superadmin', 'manager'), userCtrl.createPost);
router.get('/users/:id/edit', requireAuth, requireRole('superadmin', 'manager'), userCtrl.editPage);
router.post('/users/:id/edit', requireAuth, requireRole('superadmin', 'manager'), userCtrl.editPost);
router.post('/users/:id/delete', requireAuth, requireRole('superadmin', 'manager'), userCtrl.deleteUser);
router.post('/users/:id/impersonate', requireAuth, requireRole('superadmin', 'manager'), userCtrl.impersonate);
router.get('/stop-impersonate', requireAuth, userCtrl.stopImpersonate);

// Devices
router.get('/devices', requireAuth, deviceCtrl.index);
router.post('/devices/create', requireAuth, deviceCtrl.createPost);
router.post('/devices/:id/delete', requireAuth, requireRole('superadmin', 'manager'), deviceCtrl.deleteDevice);
router.post('/devices/:id/restart', requireAuth, deviceCtrl.restartDevice);
router.post('/devices/:id/logout', requireAuth, deviceCtrl.logoutDevice);
router.post('/devices/:id/reset', requireAuth, deviceCtrl.resetDevice);
router.post('/devices/:id/webhook', requireAuth, requireRole('superadmin', 'manager'), deviceCtrl.updateWebhookUrl);
router.post('/devices/:id/name', requireAuth, requireRole('superadmin', 'manager'), deviceCtrl.updateName);
router.post('/devices/:id/assign', requireAuth, requireRole('superadmin'), deviceCtrl.assignDevice);
router.post('/devices/:id/regenerate-key', requireAuth, requireRole('superadmin', 'manager'), deviceCtrl.regenerateApiKey);
router.post('/devices/session/:sessionId/delete', requireAuth, requireRole('superadmin'), deviceCtrl.deleteBySessionId);
router.get('/devices/:id/status', requireAuth, deviceCtrl.getStatus);
router.get('/devices/:id/groups', requireAuth, deviceCtrl.getDeviceGroups);

// Messages
router.get('/messages', requireAuth, msgCtrl.index);

// Chat (WhatsApp-style)
router.get('/chat', requireAuth, chatCtrl.index);
router.get('/chat/api/chats', requireAuth, chatCtrl.getChats);
router.get('/chat/api/messages', requireAuth, chatCtrl.getMessages);
router.post('/chat/api/send', requireAuth, chatCtrl.sendMessage);
router.post('/chat/api/send-media', requireAuth, chatCtrl.uploadMiddleware, chatCtrl.sendMedia);
router.get('/chat/api/new-messages', requireAuth, chatCtrl.getNewMessages);

// Chat History (read-only archive)
router.get('/chat-history', requireAuth, chatCtrl.historyIndex);
router.get('/chat-history/api/chats', requireAuth, chatCtrl.historyChats);
router.get('/chat-history/api/messages', requireAuth, chatCtrl.historyMessages);

// Analytics
router.get('/analytics', requireAuth, requireRole('superadmin', 'manager'), analyticsCtrl.index);

// Monitor (superadmin + manager)
router.get('/monitor', requireAuth, requireRole('superadmin', 'manager'), monitorCtrl.index);
router.get('/monitor/stats', requireAuth, requireRole('superadmin', 'manager'), monitorCtrl.stats);

// API Docs
router.get('/docs', requireAuth, apiDocsCtrl.index);

// Settings (superadmin only)
router.get('/settings', requireAuth, requireRole('superadmin'), settingsCtrl.index);
router.post('/settings', requireAuth, requireRole('superadmin'), settingsCtrl.update);
router.post('/settings/upload/:type', requireAuth, requireRole('superadmin'), settingsCtrl.uploadFile);

export default router;
