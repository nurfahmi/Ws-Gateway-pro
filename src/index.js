import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import expressLayouts from 'express-ejs-layouts';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import { createServer } from 'http';
import { initSocketIO } from './socket.js';

import { initDb } from './db.js';
import { restoreSessions, initGlobalWebhook } from './whatsapp.js';
import { initSetup } from './controllers/setupController.js';
import routes from './routes/index.js';
import { apiKeyAuth } from './middleware/apiKeyAuth.js';

// Import all API route handlers from the original setup
import {
  getAllSessions, createSession, getSession, deleteSession,
  updateWebhook, getGlobalWebhook, setGlobalWebhook,
  getMessageStatus, getSessionMessages, STATUS_MAP,
  getProfilePicture, getContact, getAllContacts,
  markAsRead, sendPresence, downloadMedia,
  getGroups
} from './whatsapp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = initSocketIO(httpServer);
const port = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(cors());

// CSP + no-cache
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; font-src * data:; img-src * data: blob:; style-src * 'unsafe-inline'; script-src * 'unsafe-inline' 'unsafe-eval';");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// Session
app.use(session({
  secret: process.env.SESSION_SECRET || 'wa-gateway-secret',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 24h
    secure: 'auto',
    sameSite: 'lax'
  }
}));

// EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

// ===== API Routes (protected by API key) =====
app.get('/api/sessions', apiKeyAuth, (req, res) => {
  res.json(getAllSessions());
});

app.post('/api/sessions', apiKeyAuth, async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  await createSession(sessionId);
  res.json({ message: 'Session initialization started', sessionId });
});

app.get('/api/sessions/:id', apiKeyAuth, (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ status: session.status, qr: session.qr });
});

app.delete('/api/sessions', apiKeyAuth, async (req, res) => {
  const sessions = getAllSessions();
  const sessionIds = Object.keys(sessions);
  for (const id of sessionIds) { await deleteSession(id); }
  res.json({ message: 'All sessions deleted', count: sessionIds.length });
});

app.delete('/api/sessions/:id', apiKeyAuth, async (req, res) => {
  await deleteSession(req.params.id);
  res.json({ message: 'Session deleted' });
});

app.post('/api/sessions/:id/restart', apiKeyAuth, async (req, res) => {
  await createSession(req.params.id);
  res.json({ message: 'Session restarted', sessionId: req.params.id });
});

app.put('/api/sessions/:id/webhook', apiKeyAuth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  const success = await updateWebhook(req.params.id, url);
  if (!success) return res.status(500).json({ error: 'Failed to update webhook' });
  res.json({ message: 'Webhook updated', sessionId: req.params.id, url });
});

app.get('/api/settings/webhook', apiKeyAuth, (req, res) => {
  res.json({ url: getGlobalWebhook() || '' });
});

app.post('/api/settings/webhook', apiKeyAuth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  if (await setGlobalWebhook(url)) {
    res.json({ message: 'Global webhook updated', url });
  } else {
    res.status(500).json({ error: 'Failed to update global webhook' });
  }
});

app.post('/api/sessions/:id/send-message', apiKeyAuth, async (req, res) => {
  const { id } = req.params;
  const { jid, message } = req.body;
  const session = getSession(id);
  if (!session || session.status !== 'connected') {
    return res.status(400).json({ error: 'Session not connected' });
  }
  try {
    const response = await session.sendMessage(jid, message);
    res.json({ status: 'success', messageId: response?.key?.id, response });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to send message', details: error.message });
  }
});

app.post('/api/sessions/:id/read', apiKeyAuth, async (req, res) => {
  const { id } = req.params;
  const { messages } = req.body;
  if (!messages || (!Array.isArray(messages) && !messages.remoteJid)) {
    return res.status(400).json({ error: 'messages is required' });
  }
  const session = getSession(id);
  if (!session || session.status !== 'connected') {
    return res.status(400).json({ error: 'Session not connected' });
  }
  try {
    const messageList = Array.isArray(messages) ? messages : [messages];
    const result = await markAsRead(id, messageList);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to mark as read', details: error.message });
  }
});

app.post('/api/sessions/:id/presence', apiKeyAuth, async (req, res) => {
  const { id } = req.params;
  const { jid, presence } = req.body;
  if (!jid || !presence) {
    return res.status(400).json({ error: 'jid and presence are required' });
  }
  const validPresences = ['composing', 'paused', 'recording', 'available', 'unavailable'];
  if (!validPresences.includes(presence)) {
    return res.status(400).json({ error: 'Invalid presence value', validPresences });
  }
  const session = getSession(id);
  if (!session || session.status !== 'connected') {
    return res.status(400).json({ error: 'Session not connected' });
  }
  try {
    const result = await sendPresence(id, jid, presence);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to send presence', details: error.message });
  }
});

app.post('/api/sessions/:id/download-media', apiKeyAuth, async (req, res) => {
  const { id } = req.params;
  const { message } = req.body;
  if (!message || !message.message) {
    return res.status(400).json({ error: 'message object is required' });
  }
  const session = getSession(id);
  if (!session || session.status !== 'connected') {
    return res.status(400).json({ error: 'Session not connected' });
  }
  try {
    const result = await downloadMedia(id, message);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to download media', details: error.message });
  }
});

app.get('/api/sessions/:id/messages/:messageId/status', apiKeyAuth, (req, res) => {
  const status = getMessageStatus(req.params.id, req.params.messageId);
  if (!status) return res.status(404).json({ error: 'Message not found' });
  res.json(status);
});

app.get('/api/sessions/:id/messages', apiKeyAuth, (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const messages = getSessionMessages(req.params.id, parseInt(req.query.limit) || 50);
  res.json({ sessionId: req.params.id, count: messages.length, messages });
});

app.get('/api/message-status-codes', apiKeyAuth, (req, res) => {
  res.json({ codes: STATUS_MAP });
});

app.get('/api/sessions/:id/profile-picture/:jid', apiKeyAuth, async (req, res) => {
  const session = getSession(req.params.id);
  if (!session || session.status !== 'connected') {
    return res.status(400).json({ error: 'Session not connected' });
  }
  try {
    const url = await getProfilePicture(req.params.id, req.params.jid);
    res.json({ jid: req.params.jid, profilePicUrl: url });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch profile picture', details: error.message });
  }
});

app.get('/api/sessions/:id/contacts', apiKeyAuth, (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const contacts = getAllContacts(req.params.id);
  res.json({ sessionId: req.params.id, count: contacts.length, contacts });
});

app.get('/api/sessions/:id/contacts/:jid', apiKeyAuth, async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const contact = getContact(req.params.id, req.params.jid);
  let profilePicUrl = null;
  if (session.status === 'connected') {
    try { profilePicUrl = await getProfilePicture(req.params.id, req.params.jid); } catch (e) {}
  }
  res.json(contact ? { ...contact, profilePicUrl } : { jid: req.params.jid, profilePicUrl });
});

app.get('/api/sessions/:id/groups', apiKeyAuth, async (req, res) => {
  const session = getSession(req.params.id);
  if (!session || session.status !== 'connected') {
    return res.status(400).json({ error: 'Session not connected' });
  }
  try {
    const groups = await getGroups(req.params.id);
    res.json({ sessionId: req.params.id, count: groups.length, groups });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch groups', details: error.message });
  }
});

// ===== Shorthand API Routes (no session ID needed, resolved from API key) =====
app.post('/api/send-message', apiKeyAuth, async (req, res) => {
  const id = req.params.id; // auto-resolved by middleware
  const { jid, message } = req.body;
  const session = getSession(id);
  if (!session || session.status !== 'connected') {
    return res.status(400).json({ error: 'Session not connected' });
  }
  try {
    const response = await session.sendMessage(jid, message);
    res.json({ status: 'success', messageId: response?.key?.id, response });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to send message', details: error.message });
  }
});

// Simplified send to person (auto-appends @s.whatsapp.net)
app.post('/api/send', apiKeyAuth, async (req, res) => {
  const id = req.params.id;
  const { to, body } = req.body;
  if (!to || !body) return res.status(400).json({ error: 'to and body are required' });

  const session = getSession(id);
  if (!session || session.status !== 'connected') {
    return res.status(400).json({ error: 'Session not connected' });
  }

  const recipients = Array.isArray(to) ? to : [to];
  const results = [];
  for (const num of recipients) {
    const jid = num.includes('@') ? num : `${num}@s.whatsapp.net`;
    try {
      const r = await session.sendMessage(jid, { text: body });
      results.push({ to: num, status: 'sent', messageId: r?.key?.id });
    } catch (e) {
      results.push({ to: num, status: 'failed', error: e.message });
    }
  }
  res.json({ status: 'success', results });
});

// Simplified send to group (auto-appends @g.us)
app.post('/api/send-group', apiKeyAuth, async (req, res) => {
  const id = req.params.id;
  const { to, body } = req.body;
  if (!to || !body) return res.status(400).json({ error: 'to and body are required' });

  const session = getSession(id);
  if (!session || session.status !== 'connected') {
    return res.status(400).json({ error: 'Session not connected' });
  }

  const recipients = Array.isArray(to) ? to : [to];
  const results = [];
  for (const gid of recipients) {
    const jid = gid.includes('@') ? gid : `${gid}@g.us`;
    try {
      const r = await session.sendMessage(jid, { text: body });
      results.push({ to: gid, status: 'sent', messageId: r?.key?.id });
    } catch (e) {
      results.push({ to: gid, status: 'failed', error: e.message });
    }
  }
  res.json({ status: 'success', results });
});

app.post('/api/download-media', apiKeyAuth, async (req, res) => {
  const id = req.params.id;
  const { message } = req.body;
  if (!message || !message.message) {
    return res.status(400).json({ error: 'message object is required' });
  }
  const session = getSession(id);
  if (!session || session.status !== 'connected') {
    return res.status(400).json({ error: 'Session not connected' });
  }
  try {
    const result = await downloadMedia(id, message);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to download media', details: error.message });
  }
});

app.put('/api/webhook', apiKeyAuth, async (req, res) => {
  const id = req.params.id;
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  const success = await updateWebhook(id, url);
  if (!success) return res.status(500).json({ error: 'Failed to update webhook' });
  res.json({ message: 'Webhook updated', sessionId: id, url });
});

app.get('/api/session', apiKeyAuth, (req, res) => {
  const id = req.params.id;
  const session = getSession(id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ sessionId: id, status: session.status, qr: session.qr });
});

app.post('/api/restart', apiKeyAuth, async (req, res) => {
  const id = req.params.id;
  await createSession(id);
  res.json({ message: 'Session restarted', sessionId: id });
});

app.get('/api/messages', apiKeyAuth, (req, res) => {
  const id = req.params.id;
  const session = getSession(id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const messages = getSessionMessages(id, parseInt(req.query.limit) || 50);
  res.json({ sessionId: id, count: messages.length, messages });
});

app.get('/api/contacts', apiKeyAuth, (req, res) => {
  const id = req.params.id;
  const session = getSession(id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const contacts = getAllContacts(id);
  res.json({ sessionId: id, count: contacts.length, contacts });
});

app.post('/api/read', apiKeyAuth, async (req, res) => {
  const id = req.params.id;
  const { messages } = req.body;
  if (!messages || (!Array.isArray(messages) && !messages.remoteJid)) {
    return res.status(400).json({ error: 'messages is required' });
  }
  const session = getSession(id);
  if (!session || session.status !== 'connected') {
    return res.status(400).json({ error: 'Session not connected' });
  }
  try {
    const messageList = Array.isArray(messages) ? messages : [messages];
    const result = await markAsRead(id, messageList);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to mark as read', details: error.message });
  }
});

app.post('/api/presence', apiKeyAuth, async (req, res) => {
  const id = req.params.id;
  const { jid, presence } = req.body;
  if (!jid || !presence) {
    return res.status(400).json({ error: 'jid and presence are required' });
  }
  const validPresences = ['composing', 'paused', 'recording', 'available', 'unavailable'];
  if (!validPresences.includes(presence)) {
    return res.status(400).json({ error: 'Invalid presence value', validPresences });
  }
  const session = getSession(id);
  if (!session || session.status !== 'connected') {
    return res.status(400).json({ error: 'Session not connected' });
  }
  try {
    const result = await sendPresence(id, jid, presence);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to send presence', details: error.message });
  }
});

app.get('/api/groups', apiKeyAuth, async (req, res) => {
  const id = req.params.id;
  const session = getSession(id);
  if (!session || session.status !== 'connected') {
    return res.status(400).json({ error: 'Session not connected' });
  }
  try {
    const groups = await getGroups(id);
    res.json({ sessionId: id, count: groups.length, groups });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch groups', details: error.message });
  }
});

// ===== Dashboard Routes (EJS, session auth) =====
app.use('/', routes);

// ===== Start Server =====
const startServer = async () => {
  await initDb();
  await initSetup();
  await initGlobalWebhook();

  // One-time cleanup: normalize old JIDs and phone numbers
  try {
    const { default: prisma } = await import('./lib/prisma.js');
    
    // 1. Strip :0 from sender_phone (e.g. 60163272787:0 -> 60163272787)
    const r1 = await prisma.$executeRawUnsafe(
      `UPDATE messages SET sender_phone = SUBSTRING_INDEX(sender_phone, ':', 1) WHERE sender_phone LIKE '%:%'`
    );
    if (r1 > 0) console.log(`[cleanup] Fixed ${r1} sender_phone records`);

    // 2. Normalize remote_jid: phone:0@s.whatsapp.net -> phone@s.whatsapp.net
    const r2 = await prisma.$executeRawUnsafe(
      `UPDATE messages SET remote_jid = CONCAT(SUBSTRING_INDEX(remote_jid, ':', 1), '@s.whatsapp.net') WHERE remote_jid LIKE '%:%@s.whatsapp.net'`
    );
    if (r2 > 0) console.log(`[cleanup] Fixed ${r2} remote_jid records`);

    // 3. Backfill sender_phone for @s.whatsapp.net JIDs that are missing it
    const r3 = await prisma.$executeRawUnsafe(
      `UPDATE messages SET sender_phone = SUBSTRING_INDEX(remote_jid, '@', 1) WHERE remote_jid LIKE '%@s.whatsapp.net' AND (sender_phone IS NULL OR sender_phone = '')`
    );
    if (r3 > 0) console.log(`[cleanup] Backfilled ${r3} sender_phone records`);

    // 4. Strip :0 from contacts table phone field
    const r4 = await prisma.$executeRawUnsafe(
      `UPDATE contacts SET phone = SUBSTRING_INDEX(phone, ':', 1) WHERE phone LIKE '%:%'`
    );
    if (r4 > 0) console.log(`[cleanup] Fixed ${r4} contact phone records`);

    // 5. Convert @lid remote_jid to phone@s.whatsapp.net when sender_phone is known
    const r5 = await prisma.$executeRawUnsafe(
      `UPDATE messages SET remote_jid = CONCAT(sender_phone, '@s.whatsapp.net') WHERE remote_jid LIKE '%@lid' AND sender_phone IS NOT NULL AND sender_phone != ''`
    );
    if (r5 > 0) console.log(`[cleanup] Converted ${r5} @lid records to phone JID`);
  } catch(e) {
    console.error('[cleanup] DB cleanup error:', e.message);
  }

  httpServer.listen(port, () => {
    console.log(`Server listening on port ${port}`);
    console.log(`Dashboard: http://localhost:${port}`);
    // Restore sessions in background — don't block server startup
    restoreSessions().catch(err => console.error('Session restore error:', err));
  });
};

// Graceful shutdown — close all Baileys sockets before exit to prevent conflicts
const gracefulShutdown = async (signal) => {
  console.log(`\n${signal} received. Closing all sessions...`);
  const sessions = getAllSessions();
  for (const sessionId of Object.keys(sessions)) {
    const session = getSession(sessionId);
    if (session?.sock) {
      try { session.sock.end(undefined); } catch(e) {}
    }
  }
  console.log('All sessions closed. Exiting.');
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
// nodemon sends SIGUSR2 before restart
process.once('SIGUSR2', async () => {
  await gracefulShutdown('SIGUSR2 (nodemon)');
  process.kill(process.pid, 'SIGUSR2');
});

// Crash guards — prevent a single session error from killing the entire process
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  // Don't exit — keep the server running
});

startServer();
