import { Router } from 'express';
import { requireAuth, requireRole, guestOnly } from '../middleware/auth.js';
import * as authCtrl from '../controllers/authController.js';
import * as dashCtrl from '../controllers/dashboardController.js';
import * as userCtrl from '../controllers/userController.js';
import * as deviceCtrl from '../controllers/deviceController.js';
import * as msgCtrl from '../controllers/messageController.js';
import * as analyticsCtrl from '../controllers/analyticsController.js';
import * as monitorCtrl from '../controllers/monitorController.js';
import * as apiDocsCtrl from '../controllers/apiDocsController.js';
import * as settingsCtrl from '../controllers/settingsController.js';
import { getSettings } from '../controllers/settingsController.js';

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

// Auth
router.get('/login', guestOnly, authCtrl.loginPage);
router.post('/login', guestOnly, authCtrl.loginPost);
router.get('/logout', authCtrl.logout);

// Root redirect
router.get('/', (req, res) => res.redirect('/dashboard'));

// Dashboard
router.get('/dashboard', requireAuth, dashCtrl.index);

// Users (superadmin + admin)
router.get('/users', requireAuth, requireRole('superadmin', 'admin'), userCtrl.index);
router.get('/users/create', requireAuth, requireRole('superadmin', 'admin'), userCtrl.createPage);
router.post('/users/create', requireAuth, requireRole('superadmin', 'admin'), userCtrl.createPost);
router.get('/users/:id/edit', requireAuth, requireRole('superadmin', 'admin'), userCtrl.editPage);
router.post('/users/:id/edit', requireAuth, requireRole('superadmin', 'admin'), userCtrl.editPost);
router.post('/users/:id/delete', requireAuth, requireRole('superadmin', 'admin'), userCtrl.deleteUser);

// Devices
router.get('/devices', requireAuth, deviceCtrl.index);
router.post('/devices/create', requireAuth, requireRole('superadmin', 'admin'), deviceCtrl.createPost);
router.post('/devices/:id/delete', requireAuth, requireRole('superadmin', 'admin'), deviceCtrl.deleteDevice);
router.post('/devices/:id/restart', requireAuth, requireRole('superadmin', 'admin'), deviceCtrl.restartDevice);
router.post('/devices/:id/webhook', requireAuth, requireRole('superadmin', 'admin'), deviceCtrl.updateWebhookUrl);
router.get('/devices/:id/status', requireAuth, deviceCtrl.getStatus);

// Messages
router.get('/messages', requireAuth, msgCtrl.index);

// Analytics
router.get('/analytics', requireAuth, analyticsCtrl.index);

// Monitor (superadmin + admin)
router.get('/monitor', requireAuth, requireRole('superadmin', 'admin'), monitorCtrl.index);
router.get('/monitor/stats', requireAuth, requireRole('superadmin', 'admin'), monitorCtrl.stats);

// API Docs
router.get('/docs', requireAuth, apiDocsCtrl.index);

// Settings (superadmin only)
router.get('/settings', requireAuth, requireRole('superadmin'), settingsCtrl.index);
router.post('/settings', requireAuth, requireRole('superadmin'), settingsCtrl.update);
router.post('/settings/upload/:type', requireAuth, requireRole('superadmin'), settingsCtrl.uploadFile);

export default router;
