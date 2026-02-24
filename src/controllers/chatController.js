import prisma from '../lib/prisma.js';
import { getSession } from '../whatsapp.js';

// Render chat page
export const index = async (req, res) => {
  const devices = await prisma.device.findMany({
    select: { id: true, sessionId: true, name: true, phoneNumber: true, status: true },
  });
  res.render('chat/index', { title: 'Chat', devices });
};

// API: Get chat list (grouped conversations) for all devices or a specific one
export const getChats = async (req, res) => {
  const { device } = req.query;

  try {
    // Build session filter
    let sessionFilter = '';
    const params = [];
    if (device) {
      sessionFilter = 'AND m.session_id = ?';
      params.push(device);
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
        ${device ? 'AND session_id = ?' : ''}
        GROUP BY session_id, remote_jid
      ) latest ON m.session_id = latest.session_id AND m.remote_jid = latest.remote_jid AND m.created_at = latest.max_date
      LEFT JOIN devices d ON d.session_id = m.session_id
      WHERE 1=1 ${sessionFilter}
      ORDER BY m.created_at DESC
    `, ...(device ? [device, device] : []));

    const chats = rawChats.map(c => ({
      sessionId: c.sessionId,
      remoteJid: c.remoteJid,
      name: c.pushName || c.remoteJid?.split('@')[0] || 'Unknown',
      deviceName: c.deviceName || c.sessionId,
      phoneNumber: c.phoneNumber || null,
      lastMessage: c.fromMe ? `You: ${c.lastMessage || `[${c.messageType}]`}` : (c.lastMessage || `[${c.messageType}]`),
      messageType: c.messageType,
      time: c.createdAt,
      totalMessages: Number(c.totalMessages),
      isGroup: c.remoteJid?.includes('@g.us') || false,
    }));

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

  try {
    const where = { sessionId: device, remoteJid: jid };
    const [messages, total] = await Promise.all([
      prisma.message.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.message.count({ where }),
    ]);

    res.json({
      messages: messages.reverse(),
      hasMore: page * limit < total,
      total,
    });
  } catch (error) {
    console.error('getMessages error:', error);
    res.status(500).json({ error: error.message });
  }
};

// API: Send a message from chat UI
export const sendMessage = async (req, res) => {
  const { device, jid, text } = req.body;
  if (!device || !jid || !text) {
    return res.status(400).json({ error: 'device, jid, and text are required' });
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
