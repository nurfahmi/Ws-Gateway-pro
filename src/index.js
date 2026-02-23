import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import expressLayouts from 'express-ejs-layouts';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';

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
  markAsRead, sendPresence, downloadMedia
} from './whatsapp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
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

// ===== Dashboard Routes (EJS, session auth) =====
app.use('/', routes);

// ===== Start Server =====
const startServer = async () => {
  await initDb();
  await initSetup();
  await initGlobalWebhook();
  await restoreSessions();

  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
    console.log(`Dashboard: http://localhost:${port}`);
  });
};

startServer();
