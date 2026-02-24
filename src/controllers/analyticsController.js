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
  const days = parseInt(req.query.days) || 7;
  const now = new Date();
  const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const allowedSessionIds = await getAllowedSessionIds(req.session.user);

  let sessionFilter = '';
  const filterParams = [];
  if (allowedSessionIds) {
    if (allowedSessionIds.length === 0) {
      return res.render('analytics/index', {
        title: 'Analytics',
        days,
        dailyMessages: [],
        perDevice: [],
        hourly: [],
      });
    }
    sessionFilter = `AND m.session_id IN (${allowedSessionIds.map(() => '?').join(',')})`;
    filterParams.push(...allowedSessionIds);
  }

  // Messages per day
  const dailyMessages = await prisma.$queryRawUnsafe(`
    SELECT DATE(created_at) as date,
           SUM(CASE WHEN from_me = 1 THEN 1 ELSE 0 END) as outgoing,
           SUM(CASE WHEN from_me = 0 THEN 1 ELSE 0 END) as incoming,
           COUNT(*) as total
    FROM messages m
    WHERE created_at >= ?
    ${allowedSessionIds ? `AND m.session_id IN (${allowedSessionIds.map(() => '?').join(',')})` : ''}
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `, startDate, ...filterParams);

  // Messages per device
  const perDevice = await prisma.$queryRawUnsafe(`
    SELECT m.session_id as sessionId, d.name as deviceName, COUNT(*) as total
    FROM messages m
    LEFT JOIN devices d ON m.session_id = d.session_id
    WHERE m.created_at >= ?
    ${allowedSessionIds ? `AND m.session_id IN (${allowedSessionIds.map(() => '?').join(',')})` : ''}
    GROUP BY m.session_id, d.name
    ORDER BY total DESC
    LIMIT 10
  `, startDate, ...filterParams);

  // Hourly distribution
  const hourly = await prisma.$queryRawUnsafe(`
    SELECT HOUR(created_at) as hour, COUNT(*) as total
    FROM messages m
    WHERE created_at >= ?
    ${allowedSessionIds ? `AND m.session_id IN (${allowedSessionIds.map(() => '?').join(',')})` : ''}
    GROUP BY HOUR(created_at)
    ORDER BY hour ASC
  `, startDate, ...filterParams);

  // Serialize BigInt values to numbers for JSON
  const serialize = (arr) => arr.map(row => {
    const obj = {};
    for (const [k, v] of Object.entries(row)) {
      obj[k] = typeof v === 'bigint' ? Number(v) : v;
    }
    return obj;
  });

  res.render('analytics/index', {
    title: 'Analytics',
    days,
    dailyMessages: serialize(dailyMessages),
    perDevice: serialize(perDevice),
    hourly: serialize(hourly),
  });
};
