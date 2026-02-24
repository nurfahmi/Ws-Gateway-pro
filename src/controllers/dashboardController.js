import prisma from '../lib/prisma.js';
import { getAllSessions } from '../whatsapp.js';

async function getAllowedDeviceSessionIds(sessionUser) {
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

export const index = async (req, res) => {
  try {
    const user = req.session.user;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const allowedSessionIds = await getAllowedDeviceSessionIds(user);

    // Build where clause for scoped queries
    const deviceWhere = allowedSessionIds ? { sessionId: { in: allowedSessionIds } } : {};
    const messageWhere = allowedSessionIds ? { sessionId: { in: allowedSessionIds } } : {};
    const messageTodayWhere = allowedSessionIds
      ? { sessionId: { in: allowedSessionIds }, createdAt: { gte: today } }
      : { createdAt: { gte: today } };

    const [totalDevices, totalUsers, messagesToday, totalMessages] = await Promise.all([
      prisma.device.count({ where: allowedSessionIds ? { sessionId: { in: allowedSessionIds } } : {} }),
      user.role === 'superadmin' ? prisma.user.count() : Promise.resolve(0),
      prisma.message.count({ where: messageTodayWhere }),
      prisma.message.count({ where: messageWhere }),
    ]);

    const sessions = getAllSessions();
    let activeSessions;
    if (allowedSessionIds) {
      activeSessions = Object.entries(sessions)
        .filter(([sid]) => allowedSessionIds.includes(sid))
        .filter(([, s]) => s.status === 'connected').length;
    } else {
      activeSessions = Object.values(sessions).filter(s => s.status === 'connected').length;
    }

    const recentMessages = await prisma.message.findMany({
      where: messageWhere,
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    res.render('dashboard', {
      title: 'Dashboard',
      stats: { totalDevices, totalUsers, messagesToday, totalMessages, activeSessions },
      recentMessages,
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.render('dashboard', {
      title: 'Dashboard',
      stats: { totalDevices: 0, totalUsers: 0, messagesToday: 0, totalMessages: 0, activeSessions: 0 },
      recentMessages: [],
    });
  }
};
