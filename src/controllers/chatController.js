import prisma from '../lib/prisma.js';

// Render chat page
export const index = async (req, res) => {
  const devices = await prisma.device.findMany({
    select: { id: true, sessionId: true, name: true, status: true },
  });
  res.render('chat/index', { title: 'Chat', devices });
};

// API: Get chat list (grouped conversations) for a device
export const getChats = async (req, res) => {
  const { device } = req.query;
  if (!device) return res.json([]);

  try {
    // Get the latest message per remoteJid for this device
    const rawChats = await prisma.$queryRaw`
      SELECT 
        m.remote_jid as remoteJid,
        m.push_name as pushName,
        m.content as lastMessage,
        m.message_type as messageType,
        m.from_me as fromMe,
        m.created_at as createdAt,
        m.timestamp,
        (SELECT COUNT(*) FROM messages m2 WHERE m2.session_id = m.session_id AND m2.remote_jid = m.remote_jid) as totalMessages
      FROM messages m
      INNER JOIN (
        SELECT remote_jid, MAX(created_at) as max_date
        FROM messages
        WHERE session_id = ${device}
        AND remote_jid IS NOT NULL
        AND remote_jid != ''
        GROUP BY remote_jid
      ) latest ON m.remote_jid = latest.remote_jid AND m.created_at = latest.max_date
      WHERE m.session_id = ${device}
      ORDER BY m.created_at DESC
    `;

    const chats = rawChats.map(c => ({
      remoteJid: c.remoteJid,
      name: c.pushName || c.remoteJid?.split('@')[0] || 'Unknown',
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
      messages: messages.reverse(), // oldest first for display
      hasMore: page * limit < total,
      total,
    });
  } catch (error) {
    console.error('getMessages error:', error);
    res.status(500).json({ error: error.message });
  }
};
