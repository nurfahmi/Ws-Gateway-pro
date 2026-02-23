import prisma from '../lib/prisma.js';
import { createSession, getSession, getAllSessions, deleteSession as deleteWASession, updateWebhook } from '../whatsapp.js';

export const index = async (req, res) => {
  const user = req.session.user;
  const isAdmin = user.role === 'superadmin' || user.role === 'admin';
  const statusFilter = req.query.status || 'all';
  const page = parseInt(req.query.page) || 1;
  const limit = 15;

  // Fetch DB devices based on role
  const where = isAdmin ? {} : { createdBy: user.id };
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

  // For admin/superadmin: also show live sessions not yet in DB
  if (isAdmin) {
    for (const [sessionId, sess] of Object.entries(sessions)) {
      if (!dbSessionIds.has(sessionId)) {
        allDevices.push({
          id: null,
          sessionId,
          name: sessionId,
          phoneNumber: null,
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

  res.render('devices/index', {
    title: 'Device Management',
    devices: paginatedDevices,
    statusFilter,
    pagination: { page, totalPages, total },
  });
};

export const createPost = async (req, res) => {
  const { sessionId, name } = req.body;
  if (!sessionId) return res.redirect('/devices');

  try {
    await prisma.device.create({
      data: {
        sessionId,
        name: name || sessionId,
        createdBy: req.session.user.id,
      },
    });
    await createSession(sessionId);
    res.redirect('/devices');
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
      await deleteWASession(device.sessionId);
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
      await prisma.device.update({ where: { id: parseInt(id) }, data: { webhookUrl } });
      await updateWebhook(device.sessionId, webhookUrl);
    }
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
