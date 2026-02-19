import prisma from '../lib/prisma.js';

export const index = async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const now = new Date();
  const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  // Messages per day
  const dailyMessages = await prisma.$queryRaw`
    SELECT DATE(created_at) as date,
           SUM(CASE WHEN from_me = 1 THEN 1 ELSE 0 END) as outgoing,
           SUM(CASE WHEN from_me = 0 THEN 1 ELSE 0 END) as incoming,
           COUNT(*) as total
    FROM messages
    WHERE created_at >= ${startDate}
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `;

  // Messages per device
  const perDevice = await prisma.$queryRaw`
    SELECT m.session_id as sessionId, d.name as deviceName, COUNT(*) as total
    FROM messages m
    LEFT JOIN devices d ON m.session_id = d.session_id
    WHERE m.created_at >= ${startDate}
    GROUP BY m.session_id, d.name
    ORDER BY total DESC
    LIMIT 10
  `;

  // Hourly distribution
  const hourly = await prisma.$queryRaw`
    SELECT HOUR(created_at) as hour, COUNT(*) as total
    FROM messages
    WHERE created_at >= ${startDate}
    GROUP BY HOUR(created_at)
    ORDER BY hour ASC
  `;

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
