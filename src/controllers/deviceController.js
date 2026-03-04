import prisma from '../lib/prisma.js';
import crypto from 'crypto';
import { createSession, getSession, getAllSessions, deleteSession as deleteWASession, updateWebhook, getGroups } from '../whatsapp.js';

/**
 * Get allowed user IDs for device access based on role:
 * - superadmin: all devices (returns null = no filter)
 * - manager: own devices + devices of assigned users
 * - user: only own devices
 */
async function getAllowedUserIds(sessionUser) {
  if (sessionUser.role === 'superadmin') return null; // no filter
  if (sessionUser.role === 'manager') {
    const managedUsers = await prisma.user.findMany({
      where: { managerId: sessionUser.id },
      select: { id: true },
    });
    return [sessionUser.id, ...managedUsers.map(u => u.id)];
  }
  return [sessionUser.id]; // user role
}

export const index = async (req, res) => {
  const user = req.session.user;
  const isSuperadmin = user.role === 'superadmin';
  const statusFilter = req.query.status || 'all';
  const page = parseInt(req.query.page) || 1;
  const limit = 15;

  const allowedIds = await getAllowedUserIds(user);
  const where = allowedIds ? { createdBy: { in: allowedIds } } : {};

  const devices = await prisma.device.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: { creator: { select: { name: true } } },
  });

  const sessions = getAllSessions();
  const dbSessionIds = new Set(devices.map(d => d.sessionId));

  // Build combined list
  let allDevices = devices.map(d => ({
    ...d,
    liveStatus: sessions[d.sessionId]?.status || 'offline',
    qr: sessions[d.sessionId]?.qr || null,
  }));

  // For superadmin: also show live sessions not yet in DB
  if (isSuperadmin) {
    for (const [sessionId, sess] of Object.entries(sessions)) {
      if (!dbSessionIds.has(sessionId)) {
        allDevices.push({
          id: null,
          sessionId,
          name: sessionId,
          phoneNumber: null,
          apiKey: null,
          status: sess.status,
          webhookUrl: sess.webhookUrl || null,
          createdBy: null,
          creator: null,
          createdAt: null,
          updatedAt: null,
          liveStatus: sess.status,
          qr: sess.qr || null,
        });
      }
    }
  }

  // Apply status filter
  if (statusFilter !== 'all') {
    allDevices = allDevices.filter(d => d.liveStatus === statusFilter);
  }

  // Pagination
  const total = allDevices.length;
  const totalPages = Math.ceil(total / limit);
  const paginatedDevices = allDevices.slice((page - 1) * limit, page * limit);

  // For managers: fetch their staff list for the assign dropdown
  let staffList = [];
  if (user.role === 'manager') {
    staffList = await prisma.user.findMany({
      where: { managerId: user.id },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  res.render('devices/index', {
    title: 'Device Management',
    devices: paginatedDevices,
    statusFilter,
    pagination: { page, totalPages, total },
    staffList,
  });
};

export const createPost = async (req, res) => {
  const { sessionId, name, assignTo } = req.body;
  if (!sessionId) return res.redirect('/devices');

  let ownerId = req.session.user.id;

  // Users (staff) can only have max 2 devices
  if (req.session.user.role === 'user') {
    const count = await prisma.device.count({ where: { createdBy: ownerId } });
    if (count >= 2) {
      return res.redirect('/devices?error=Maximum+2+devices+allowed');
    }
  }

  // If manager assigns to a staff member, verify ownership
  if (assignTo && req.session.user.role === 'manager') {
    const staffId = parseInt(assignTo);
    const staff = await prisma.user.findFirst({
      where: { id: staffId, managerId: req.session.user.id },
    });
    if (staff) ownerId = staffId;
  }

  try {
    const device = await prisma.device.create({
      data: {
        sessionId,
        name: name || sessionId,
        apiKey: crypto.randomUUID(),
        createdBy: ownerId,
      },
    });
    await createSession(sessionId);
    res.redirect('/devices?new=' + device.id);
  } catch (err) {
    if (err.code === 'P2002') {
      return res.redirect('/devices?error=Device+already+exists');
    }
    console.error(err);
    res.redirect('/devices');
  }
};

export const deleteDevice = async (req, res) => {
  const { id } = req.params;
  try {
    const device = await prisma.device.findUnique({ where: { id: parseInt(id) } });
    if (device) {
      // Manager can only delete their own or their users' devices
      const allowedIds = await getAllowedUserIds(req.session.user);
      if (allowedIds && !allowedIds.includes(device.createdBy)) {
        return res.status(403).render('403', { title: 'Forbidden' });
      }
      await deleteWASession(device.sessionId);
      await prisma.message.deleteMany({ where: { sessionId: device.sessionId } });
      await prisma.device.delete({ where: { id: parseInt(id) } });
    }
    res.redirect('/devices');
  } catch (err) {
    console.error(err);
    res.redirect('/devices');
  }
};

export const restartDevice = async (req, res) => {
  const { id } = req.params;
  try {
    const device = await prisma.device.findUnique({ where: { id: parseInt(id) } });
    if (device) {
      const allowedIds = await getAllowedUserIds(req.session.user);
      if (allowedIds && !allowedIds.includes(device.createdBy)) {
        return res.status(403).render('403', { title: 'Forbidden' });
      }
      await createSession(device.sessionId);
    }
    res.redirect('/devices');
  } catch (err) {
    console.error(err);
    res.redirect('/devices');
  }
};

export const updateWebhookUrl = async (req, res) => {
  const { id } = req.params;
  const { webhookUrl } = req.body;
  try {
    const device = await prisma.device.findUnique({ where: { id: parseInt(id) } });
    if (device) {
      const allowedIds = await getAllowedUserIds(req.session.user);
      if (allowedIds && !allowedIds.includes(device.createdBy)) {
        return res.status(403).render('403', { title: 'Forbidden' });
      }
      await prisma.device.update({ where: { id: parseInt(id) }, data: { webhookUrl } });
      await updateWebhook(device.sessionId, webhookUrl);
    }
    res.redirect('/devices');
  } catch (err) {
    console.error(err);
    res.redirect('/devices');
  }
};

// Regenerate API key for a device
export const regenerateApiKey = async (req, res) => {
  const { id } = req.params;
  try {
    const device = await prisma.device.findUnique({ where: { id: parseInt(id) } });
    if (device) {
      const allowedIds = await getAllowedUserIds(req.session.user);
      if (allowedIds && !allowedIds.includes(device.createdBy)) {
        return res.status(403).render('403', { title: 'Forbidden' });
      }
    }
    await prisma.device.update({
      where: { id: parseInt(id) },
      data: { apiKey: crypto.randomUUID() },
    });
    res.redirect('/devices');
  } catch (err) {
    console.error(err);
    res.redirect('/devices');
  }
};

// Update device name (superadmin/manager only)
export const updateName = async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  try {
    const device = await prisma.device.findUnique({ where: { id: parseInt(id) } });
    if (device) {
      const allowedIds = await getAllowedUserIds(req.session.user);
      if (allowedIds && !allowedIds.includes(device.createdBy)) {
        return res.status(403).render('403', { title: 'Forbidden' });
      }
    }
    await prisma.device.update({
      where: { id: parseInt(id) },
      data: { name: name || device.sessionId },
    });
    res.redirect('/devices');
  } catch (err) {
    console.error(err);
    res.redirect('/devices');
  }
};

// Delete unregistered session by sessionId (superadmin only)
export const deleteBySessionId = async (req, res) => {
  const { sessionId } = req.params;
  try {
    await deleteWASession(sessionId);
    res.redirect('/devices');
  } catch (err) {
    console.error(err);
    res.redirect('/devices');
  }
};

// API endpoint to get QR and status for polling
export const getStatus = async (req, res) => {
  const { id } = req.params;
  try {
    const device = await prisma.device.findUnique({ where: { id: parseInt(id) } });
    if (!device) return res.json({ error: 'Not found' });
    const session = getSession(device.sessionId);
    res.json({
      status: session?.status || 'offline',
      qr: session?.qr || null,
    });
  } catch (err) {
    res.json({ error: err.message });
  }
};

// Get all groups for a device (JSON endpoint for modal)
export const getDeviceGroups = async (req, res) => {
  const { id } = req.params;
  try {
    const device = await prisma.device.findUnique({ where: { id: parseInt(id) } });
    if (!device) return res.status(404).json({ error: 'Device not found' });
    const allowedIds = await getAllowedUserIds(req.session.user);
    if (allowedIds && !allowedIds.includes(device.createdBy)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const groups = await getGroups(device.sessionId);
    res.json({ groups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
