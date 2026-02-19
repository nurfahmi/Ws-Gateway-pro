import prisma from '../lib/prisma.js';
import { getAllSessions } from '../whatsapp.js';

export const index = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [totalDevices, totalUsers, messagesToday, totalMessages] = await Promise.all([
      prisma.device.count(),
      prisma.user.count(),
      prisma.message.count({ where: { createdAt: { gte: today } } }),
      prisma.message.count(),
    ]);

    const sessions = getAllSessions();
    const activeSessions = Object.values(sessions).filter(s => s.status === 'connected').length;

    const recentMessages = await prisma.message.findMany({
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
