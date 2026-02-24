import prisma from '../lib/prisma.js';

async function getAllowedSessionIds(sessionUser) {
  if (sessionUser.role === 'superadmin') return null;
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

export const index = async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 50;
  const skip = (page - 1) * limit;
  const direction = req.query.direction || 'all';
  const sessionId = req.query.device || '';

  const allowedSessionIds = await getAllowedSessionIds(req.session.user);

  const where = {};
  if (direction === 'incoming') where.fromMe = false;
  if (direction === 'outgoing') where.fromMe = true;
  if (sessionId) {
    where.sessionId = sessionId;
  } else if (allowedSessionIds) {
    where.sessionId = { in: allowedSessionIds };
  }

  // Get only allowed devices for the dropdown
  const devicesWhere = allowedSessionIds
    ? { sessionId: { in: allowedSessionIds } }
    : {};

  const [messages, total, devices] = await Promise.all([
    prisma.message.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.message.count({ where }),
    prisma.device.findMany({ where: devicesWhere, select: { sessionId: true, name: true } }),
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
