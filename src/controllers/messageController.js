import prisma from '../lib/prisma.js';

export const index = async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 50;
  const skip = (page - 1) * limit;
  const direction = req.query.direction || 'all'; // all, incoming, outgoing
  const sessionId = req.query.device || '';

  const where = {};
  if (direction === 'incoming') where.fromMe = false;
  if (direction === 'outgoing') where.fromMe = true;
  if (sessionId) where.sessionId = sessionId;

  const [messages, total, devices] = await Promise.all([
    prisma.message.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.message.count({ where }),
    prisma.device.findMany({ select: { sessionId: true, name: true } }),
  ]);

  const totalPages = Math.ceil(total / limit);

  res.render('messages/index', {
    title: 'Messages',
    messages,
    devices,
    filters: { direction, device: sessionId, page },
    pagination: { page, totalPages, total },
  });
};
