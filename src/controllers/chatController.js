import prisma from '../lib/prisma.js';
import { getSession, getAllSessions } from '../whatsapp.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configure multer for image uploads
const uploadDir = path.join(__dirname, '../../uploads/chat');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp',
                     'video/mp4', 'video/3gpp',
                     'application/pdf', 'application/msword',
                     'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    cb(null, allowed.includes(file.mimetype));
  },
});

export const uploadMiddleware = upload.single('file');

/**
 * Get allowed session IDs for a user based on role
 */
async function getAllowedSessionIds(sessionUser) {
  if (sessionUser.role === 'superadmin') return null; // no filter
  let userIds = [sessionUser.id];
  if (sessionUser.role === 'manager') {
    const managedUsers = await prisma.user.findMany({
      where: { managerId: sessionUser.id },
      select: { id: true },
    });
    userIds.push(...managedUsers.map(u => u.id));
  }
  const devices = await prisma.device.findMany({
    where: { createdBy: { in: userIds } },
    select: { sessionId: true },
  });
  return devices.map(d => d.sessionId);
}

// Render chat page - merge DB devices with active sessions (scoped)
export const index = async (req, res) => {
  const allowedSessionIds = await getAllowedSessionIds(req.session.user);

  const dbWhere = allowedSessionIds
    ? { sessionId: { in: allowedSessionIds } }
    : {};

  const dbDevices = await prisma.device.findMany({
    where: dbWhere,
    select: { id: true, sessionId: true, name: true, phoneNumber: true, status: true },
  });

  // Merge with active sessions that aren't in DB
  const activeSessions = getAllSessions();
  const dbSessionIds = new Set(dbDevices.map(d => d.sessionId));
  const devices = [...dbDevices];

  for (const [sessionId, session] of Object.entries(activeSessions)) {
    // Only show unregistered sessions to superadmin
    if (!dbSessionIds.has(sessionId)) {
      if (req.session.user.role === 'superadmin') {
        devices.push({ id: null, sessionId, name: sessionId, phoneNumber: null, status: session.status || 'disconnected' });
      }
    } else {
      // Update status from live session
      const dev = devices.find(d => d.sessionId === sessionId);
      if (dev) dev.status = session.status || dev.status;
    }
  }

  res.render('chat/index', { title: 'Chat', devices });
};

// API: Get chat list (grouped conversations) - scoped
export const getChats = async (req, res) => {
  const { device } = req.query;

  try {
    const allowedSessionIds = await getAllowedSessionIds(req.session.user);

    // Build session filter (two versions: subquery has no alias, outer uses m.)
    let subFilter = '';
    let outerFilter = '';
    const params = [];

    if (device) {
      // Specific device requested — verify access
      if (allowedSessionIds && !allowedSessionIds.includes(device)) {
        return res.json([]);
      }
      subFilter = 'AND session_id = ?';
      outerFilter = 'AND m.session_id = ?';
      params.push(device);
    } else if (allowedSessionIds) {
      if (allowedSessionIds.length === 0) return res.json([]);
      const placeholders = allowedSessionIds.map(() => '?').join(',');
      subFilter = `AND session_id IN (${placeholders})`;
      outerFilter = `AND m.session_id IN (${placeholders})`;
      params.push(...allowedSessionIds);
    }

    const rawChats = await prisma.$queryRawUnsafe(`
      SELECT 
        m.session_id as sessionId,
        m.remote_jid as remoteJid,
        m.push_name as pushName,
        m.content as lastMessage,
        m.message_type as messageType,
        m.from_me as fromMe,
        m.created_at as createdAt,
        m.timestamp,
        d.name as deviceName,
        d.phone_number as phoneNumber,
        (SELECT COUNT(*) FROM messages m2 WHERE m2.session_id = m.session_id AND m2.remote_jid = m.remote_jid) as totalMessages
      FROM messages m
      INNER JOIN (
        SELECT session_id, remote_jid, MAX(created_at) as max_date
        FROM messages
        WHERE remote_jid IS NOT NULL
        AND remote_jid != ''
        ${subFilter}
        GROUP BY session_id, remote_jid
      ) latest ON m.session_id = latest.session_id AND m.remote_jid = latest.remote_jid AND m.created_at = latest.max_date
      LEFT JOIN devices d ON d.session_id = m.session_id
      WHERE 1=1 ${outerFilter}
      ORDER BY m.created_at DESC
    `, ...params, ...params);

    const mediaLabels = { image: '📷 Photo', video: '🎥 Video', audio: '🎵 Audio', ptt: '🎤 Voice message', document: '📄', sticker: '🏷️ Sticker' };

    const chats = rawChats.map(c => {
      let preview = c.lastMessage || '';
      // Clean up legacy thumb:base64 content
      if (preview.startsWith('thumb:')) {
        const pipeIdx = preview.indexOf('|');
        preview = pipeIdx > 0 ? preview.substring(pipeIdx + 1) : '';
      }
      // Friendly label for media types
      const mt = c.messageType;
      if (mt && mt !== 'text' && mediaLabels[mt]) {
        const label = mt === 'document' ? `📄 ${preview || 'Document'}` : (preview ? `${mediaLabels[mt]} · ${preview}` : mediaLabels[mt]);
        preview = label;
      } else if (mt && mt !== 'text' && !preview) {
        preview = `[${mt}]`;
      }
      if (c.fromMe) preview = `You: ${preview}`;

      return {
        sessionId: c.sessionId,
        remoteJid: c.remoteJid,
        name: c.pushName || c.remoteJid?.split('@')[0] || 'Unknown',
        deviceName: c.deviceName || c.sessionId,
        phoneNumber: c.phoneNumber || null,
        lastMessage: preview,
        messageType: c.messageType,
        time: c.createdAt,
        timestamp: c.timestamp ? c.timestamp.toString() : null,
        totalMessages: Number(c.totalMessages),
        isGroup: c.remoteJid?.includes('@g.us') || false,
      };
    });

    res.json(chats);
  } catch (error) {
    console.error('getChats error:', error);
    res.status(500).json({ error: error.message });
  }
};

// API: Get messages for a specific chat
export const getMessages = async (req, res) => {
  const { device, jid } = req.query;
  const page = parseInt(req.query.page) || 1;
  const limit = 50;

  if (!device || !jid) return res.json({ messages: [], hasMore: false });

  // Verify access
  const allowedSessionIds = await getAllowedSessionIds(req.session.user);
  if (allowedSessionIds && !allowedSessionIds.includes(device)) {
    return res.json({ messages: [], hasMore: false });
  }

  try {
    const where = { sessionId: device, remoteJid: jid };
    const [rawMessages, total] = await Promise.all([
      prisma.message.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.message.count({ where }),
    ]);

    const messages = rawMessages.reverse().map(m => ({
      ...m,
      id: Number(m.id),
      timestamp: m.timestamp ? m.timestamp.toString() : null,
    }));

    res.json({
      messages,
      hasMore: page * limit < total,
      total,
    });
  } catch (error) {
    console.error('getMessages error:', error);
    res.status(500).json({ error: error.message });
  }
};

// API: Send a text message from chat UI
export const sendMessage = async (req, res) => {
  const { device, jid, text } = req.body;
  if (!device || !jid || !text) {
    return res.status(400).json({ error: 'device, jid, and text are required' });
  }

  // Verify access
  const allowedSessionIds = await getAllowedSessionIds(req.session.user);
  if (allowedSessionIds && !allowedSessionIds.includes(device)) {
    return res.status(403).json({ error: 'Access denied to this device' });
  }

  const session = getSession(device);
  if (!session || session.status !== 'connected') {
    return res.status(400).json({ error: 'Device not connected' });
  }

  try {
    const result = await session.sendMessage(jid, { text });
    res.json({
      success: true,
      messageId: result?.key?.id,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('sendMessage error:', error);
    res.status(500).json({ error: error.message });
  }
};

// API: Send an image/file from chat UI
export const sendMedia = async (req, res) => {
  const { device, jid, caption } = req.body;
  if (!device || !jid || !req.file) {
    return res.status(400).json({ error: 'device, jid, and file are required' });
  }

  // Verify access
  const allowedSessionIds = await getAllowedSessionIds(req.session.user);
  if (allowedSessionIds && !allowedSessionIds.includes(device)) {
    return res.status(403).json({ error: 'Access denied to this device' });
  }

  const session = getSession(device);
  if (!session || session.status !== 'connected') {
    return res.status(400).json({ error: 'Device not connected' });
  }

  try {
    const mime = req.file.mimetype;
    let msgPayload;

    if (mime.startsWith('image/')) {
      msgPayload = { image: req.file.buffer, caption: caption || undefined, mimetype: mime };
    } else if (mime.startsWith('video/')) {
      msgPayload = { video: req.file.buffer, caption: caption || undefined, mimetype: mime };
    } else {
      msgPayload = {
        document: req.file.buffer,
        mimetype: mime,
        fileName: req.file.originalname,
        caption: caption || undefined,
      };
    }

    const result = await session.sendMessage(jid, msgPayload);
    res.json({
      success: true,
      messageId: result?.key?.id,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('sendMedia error:', error);
    res.status(500).json({ error: error.message });
  }
};

// API: Get new messages since a given message ID
export const getNewMessages = async (req, res) => {
  const { device, jid, after } = req.query;
  if (!device || !jid || !after) return res.json([]);

  // Verify access
  const allowedSessionIds = await getAllowedSessionIds(req.session.user);
  if (allowedSessionIds && !allowedSessionIds.includes(device)) {
    return res.json([]);
  }

  try {
    const rawMessages = await prisma.message.findMany({
      where: {
        sessionId: device,
        remoteJid: jid,
        id: { gt: parseInt(after) },
      },
      orderBy: { id: 'asc' },
      take: 50,
    });

    const messages = rawMessages.map(m => ({
      ...m,
      id: Number(m.id),
      timestamp: m.timestamp ? m.timestamp.toString() : null,
    }));

    res.json(messages);
  } catch (error) {
    console.error('getNewMessages error:', error);
    res.json([]);
  }
};

// ─── Chat History (read-only, includes deleted sessions) ───

export const historyIndex = async (req, res) => {
  const allowedSessionIds = await getAllowedSessionIds(req.session.user);

  let sessionFilter = '';
  const params = [];
  if (allowedSessionIds) {
    if (allowedSessionIds.length === 0) {
      return res.render('chat-history/index', { title: 'Chat History', sessions: [] });
    }
    sessionFilter = `AND m.session_id IN (${allowedSessionIds.map(() => '?').join(',')})`;
    params.push(...allowedSessionIds);
  }

  const sessions = await prisma.$queryRawUnsafe(`
    SELECT DISTINCT m.session_id as sessionId, 
      COALESCE(d.name, m.session_id) as name,
      d.phone_number as phoneNumber,
      CASE WHEN d.id IS NOT NULL THEN 'active' ELSE 'deleted' END as status
    FROM messages m
    LEFT JOIN devices d ON d.session_id = m.session_id
    WHERE m.session_id IS NOT NULL ${sessionFilter}
    ORDER BY name
  `, ...params);
  res.render('chat-history/index', { title: 'Chat History', sessions });
};

export const historyChats = async (req, res) => {
  const { session } = req.query;
  try {
    const allowedSessionIds = await getAllowedSessionIds(req.session.user);

    let subFilter = '';
    let outerFilter = '';
    const params = [];

    if (session) {
      if (allowedSessionIds && !allowedSessionIds.includes(session)) {
        return res.json([]);
      }
      subFilter = 'AND session_id = ?';
      outerFilter = 'AND m.session_id = ?';
      params.push(session);
    } else if (allowedSessionIds) {
      if (allowedSessionIds.length === 0) return res.json([]);
      const placeholders = allowedSessionIds.map(() => '?').join(',');
      subFilter = `AND session_id IN (${placeholders})`;
      outerFilter = `AND m.session_id IN (${placeholders})`;
      params.push(...allowedSessionIds);
    }

    const rawChats = await prisma.$queryRawUnsafe(`
      SELECT 
        m.session_id as sessionId,
        m.remote_jid as remoteJid,
        m.push_name as pushName,
        m.content as lastMessage,
        m.message_type as messageType,
        m.from_me as fromMe,
        m.created_at as createdAt,
        COALESCE(d.name, m.session_id) as deviceName,
        d.phone_number as phoneNumber,
        CASE WHEN d.id IS NOT NULL THEN 'active' ELSE 'deleted' END as deviceStatus,
        (SELECT COUNT(*) FROM messages m2 WHERE m2.session_id = m.session_id AND m2.remote_jid = m.remote_jid) as totalMessages
      FROM messages m
      INNER JOIN (
        SELECT session_id, remote_jid, MAX(created_at) as max_date
        FROM messages
        WHERE remote_jid IS NOT NULL AND remote_jid != ''
        ${subFilter}
        GROUP BY session_id, remote_jid
      ) latest ON m.session_id = latest.session_id AND m.remote_jid = latest.remote_jid AND m.created_at = latest.max_date
      LEFT JOIN devices d ON d.session_id = m.session_id
      WHERE 1=1 ${outerFilter}
      ORDER BY m.created_at DESC
    `, ...params, ...params);

    const chats = rawChats.map(c => ({
      sessionId: c.sessionId,
      remoteJid: c.remoteJid,
      name: c.pushName || c.remoteJid?.split('@')[0] || 'Unknown',
      deviceName: c.deviceName || c.sessionId,
      phoneNumber: c.phoneNumber || null,
      deviceStatus: c.deviceStatus,
      lastMessage: c.fromMe ? `You: ${c.lastMessage || `[${c.messageType}]`}` : (c.lastMessage || `[${c.messageType}]`),
      messageType: c.messageType,
      time: c.createdAt,
      totalMessages: Number(c.totalMessages),
      isGroup: c.remoteJid?.includes('@g.us') || false,
    }));
    res.json(chats);
  } catch (error) {
    console.error('historyChats error:', error);
    res.status(500).json({ error: error.message });
  }
};

export const historyMessages = async (req, res) => {
  const { session, jid } = req.query;
  const page = parseInt(req.query.page) || 1;
  const limit = 50;
  if (!session || !jid) return res.json({ messages: [], hasMore: false });

  // Verify access
  const allowedSessionIds = await getAllowedSessionIds(req.session.user);
  if (allowedSessionIds && !allowedSessionIds.includes(session)) {
    return res.json({ messages: [], hasMore: false });
  }

  try {
    const where = { sessionId: session, remoteJid: jid };
    const [rawMessages, total] = await Promise.all([
      prisma.message.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      prisma.message.count({ where }),
    ]);
    const messages = rawMessages.reverse().map(m => ({
      ...m, id: Number(m.id), timestamp: m.timestamp ? m.timestamp.toString() : null,
    }));
    res.json({ messages, hasMore: page * limit < total, total });
  } catch (error) {
    console.error('historyMessages error:', error);
    res.status(500).json({ error: error.message });
  }
};
