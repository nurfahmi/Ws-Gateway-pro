import makeWASocket, { DisconnectReason, delay, downloadMediaMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import pool from './db.js';
import { useMySQLAuthState } from './mysql-auth.js';
import prisma from './lib/prisma.js';

const sessions = new Map(); // Store session data: { sock, qr, status }
const retryCount = new Map(); // Track reconnection attempts per session
const MAX_RETRIES = 10;
const BASE_DELAY = 3000; // 3 seconds
const MAX_DELAY = 5 * 60 * 1000; // 5 minutes

// Message status store: Map<sessionId, Map<messageId, statusInfo>>
const messageStore = new Map();

// Status code mapping (Baileys uses 1-5)
const STATUS_MAP = {
    1: 'pending',
    2: 'server_ack',
    3: 'delivered',
    4: 'read',
    5: 'played'
};

// Profile picture cache: Map<jid, { url, fetchedAt }>
const profilePicCache = new Map();
const PROFILE_PIC_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Contact store: Map<sessionId, Map<jid, contactInfo>>
const contactStore = new Map();

// Global webhook state
let globalWebhookUrl = process.env.WEBHOOK_URL;

// Load global webhook on start
const initGlobalWebhook = async () => {
    try {
        const [rows] = await pool.query('SELECT data FROM session_store WHERE id = ?', ['global:webhook']);
        if (rows.length > 0) {
           const data = JSON.parse(rows[0].data);
           if (data.url) globalWebhookUrl = data.url;
        }
    } catch (err) {
        console.error("Error loading global webhook", err);
    }
};

const setGlobalWebhook = async (url) => {
    globalWebhookUrl = url;
    try {
        await pool.query(
            'INSERT INTO session_store (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = ?',
            ['global:webhook', JSON.stringify({ url }), JSON.stringify({ url })]
        );
        return true;
    } catch (err) {
        console.error("Error saving global webhook", err);
        return false;
    }
}

const getGlobalWebhook = () => globalWebhookUrl;

const createSession = async (sessionId, io) => {
    // If session already exists and is open, return it
    if (sessions.has(sessionId) && sessions.get(sessionId).status === 'connected') {
        return sessions.get(sessionId);
    }

    const { state, saveCreds } = await useMySQLAuthState(pool, sessionId);

    const sock = makeWASocket({
        logger: pino({ level: 'warn' }),
        printQRInTerminal: false,
        version: [2, 3000, 1033893291],
        auth: state,
        defaultQueryTimeoutMs: 60_000,
        keepAliveIntervalMs: 30_000,
        browser: ["Chrome (Linux)", "", ""]
    });

    // Update local session state
    sessions.set(sessionId, {
        sock,
        qr: null,
        status: 'connecting'
    });
    
    // Load webhook from DB
    try {
        const [rows] = await pool.query('SELECT data FROM session_store WHERE id = ?', [`${sessionId}:webhook`]);
        if (rows.length > 0) {
            const data = JSON.parse(rows[0].data);
            if (data.url) sessions.get(sessionId).webhookUrl = data.url;
        }
    } catch(err) {
         console.error("Error loading webhook", err);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        const sessionData = sessions.get(sessionId);

        if (qr) {
            try {
                sessionData.qr = await QRCode.toDataURL(qr);
                sessionData.status = 'scan_qr';
                console.log(`[${sessionId}] QR Code generated`);
            } catch (err) {
                console.error('QR Gen Error', err);
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const errorMessage = lastDisconnect?.error?.message || '';
            
            // Don't reconnect if logged out
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;
            // Don't reconnect if QR timeout - user must explicitly request new QR
            const isQrTimeout = statusCode === DisconnectReason.timedOut && 
                               errorMessage.includes('QR refs attempts ended');
            
            const shouldReconnect = !isLoggedOut && !isQrTimeout;
            
            console.log(`[${sessionId}] Connection closed: statusCode=${statusCode}, error=${lastDisconnect?.error?.message || lastDisconnect?.error}, Reconnecting: ${shouldReconnect}`);
            
            if (isQrTimeout) {
                // QR timeout - wait for user to explicitly request new QR
                sessionData.status = 'qr_timeout';
                sessionData.qr = null;
                retryCount.delete(sessionId);
                console.log(`[${sessionId}] QR scan timeout. Use /session/restart or reconnect to generate new QR.`);
            } else if (isLoggedOut) {
                // Logged out - clean up session
                sessionData.status = 'logged_out';
                retryCount.delete(sessionId);
                deleteSession(sessionId);
            } else if (shouldReconnect) {
                const currentRetry = (retryCount.get(sessionId) || 0) + 1;
                retryCount.set(sessionId, currentRetry);

                if (currentRetry > MAX_RETRIES) {
                    console.log(`[${sessionId}] Max retries (${MAX_RETRIES}) reached. Giving up.`);
                    sessionData.status = 'failed';
                    retryCount.delete(sessionId);
                } else {
                    const delayMs = Math.min(BASE_DELAY * Math.pow(2, currentRetry - 1), MAX_DELAY);
                    console.log(`[${sessionId}] Retry ${currentRetry}/${MAX_RETRIES} in ${Math.round(delayMs / 1000)}s...`);
                    sessionData.status = 'reconnecting';
                    await delay(delayMs);
                    createSession(sessionId);
                }
            } else {
                sessionData.status = 'disconnected';
            }
        } else if (connection === 'open') {
            console.log(`[${sessionId}] Connected`);
            sessionData.status = 'connected';
            sessionData.qr = null;
            retryCount.delete(sessionId); // Reset retry count on success
            // Sync device status to DB
            try { await prisma.device.updateMany({ where: { sessionId }, data: { status: 'connected' } }); } catch(e) {}
        }

        // Also sync disconnected status
        if (connection === 'close') {
            try { await prisma.device.updateMany({ where: { sessionId }, data: { status: sessionData.status } }); } catch(e) {}
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Store contacts when they are received/updated
    sock.ev.on('contacts.upsert', (contacts) => {
        if (!contactStore.has(sessionId)) {
            contactStore.set(sessionId, new Map());
        }
        const sessionContacts = contactStore.get(sessionId);
        
        for (const contact of contacts) {
            if (contact.id) {
                sessionContacts.set(contact.id, {
                    jid: contact.id,
                    name: contact.name || contact.notify || null,
                    notify: contact.notify || null,
                    verifiedName: contact.verifiedName || null,
                    imgUrl: contact.imgUrl || null,
                    status: contact.status || null
                });
            }
        }
        console.log(`[${sessionId}] Contacts updated: ${contacts.length} contacts`);
    });

    sock.ev.on('contacts.update', (updates) => {
        if (!contactStore.has(sessionId)) return;
        const sessionContacts = contactStore.get(sessionId);
        
        for (const update of updates) {
            if (update.id && sessionContacts.has(update.id)) {
                const existing = sessionContacts.get(update.id);
                sessionContacts.set(update.id, { ...existing, ...update });
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify') {
            for (const msg of messages) {
                if (!msg.message) continue;

                const senderJid = msg.key?.remoteJid;
                let contactName = null;

                if (senderJid && !msg.key?.fromMe) {
                    const sessionContacts = contactStore.get(sessionId);
                    if (sessionContacts && sessionContacts.has(senderJid)) {
                        const contact = sessionContacts.get(senderJid);
                        contactName = contact.name || contact.verifiedName || null;
                    }
                }

                // Determine message content and type
                let content = '';
                let messageType = 'text';
                const m = msg.message;

                // Skip internal system messages
                if (m.protocolMessage || m.senderKeyDistributionMessage || m.messageContextInfo) continue;

                if (m.conversation) { content = m.conversation; }
                else if (m.extendedTextMessage) { content = m.extendedTextMessage.text || ''; }
                else if (m.imageMessage) { messageType = 'image'; content = m.imageMessage.caption || ''; }
                else if (m.videoMessage) { messageType = 'video'; content = m.videoMessage.caption || ''; }
                else if (m.audioMessage) { messageType = 'audio'; }
                else if (m.documentMessage) { messageType = 'document'; content = m.documentMessage.fileName || ''; }
                else if (m.stickerMessage) { messageType = 'sticker'; }
                else { messageType = Object.keys(m)[0] || 'unknown'; }

                // Persist message to DB
                try {
                    const saved = await prisma.message.create({
                        data: {
                            sessionId,
                            messageId: msg.key?.id || null,
                            remoteJid: senderJid || null,
                            fromMe: msg.key?.fromMe || false,
                            pushName: msg.pushName || null,
                            messageType,
                            content: content ? content.substring(0, 5000) : null,
                            status: 'received',
                            timestamp: msg.messageTimestamp ? BigInt(msg.messageTimestamp) : null,
                        },
                    });

                    // Emit to Socket.IO for real-time chat
                    try {
                        const { getIO } = await import('./socket.js');
                        const io = getIO();
                        if (io) {
                            io.emit('new-message', {
                                id: Number(saved.id),
                                sessionId,
                                remoteJid: senderJid,
                                fromMe: msg.key?.fromMe || false,
                                pushName: msg.pushName || null,
                                messageType,
                                content: content ? content.substring(0, 5000) : null,
                                status: 'received',
                                createdAt: saved.createdAt,
                            });
                        }
                    } catch(e) {}
                } catch (dbErr) {
                    console.error(`[${sessionId}] DB save failed:`, dbErr.message);
                }

                // Send webhook
                const sessionData = sessions.get(sessionId);
                const webhookUrl = sessionData?.webhookUrl || globalWebhookUrl;
                if (!webhookUrl) continue;

                try {
                    await fetch(webhookUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            event: 'messages.upsert',
                            sessionId,
                            data: msg,
                            senderInfo: {
                                jid: senderJid,
                                pushName: msg.pushName || null,
                                contactName: contactName
                            }
                        })
                    });
                    console.log(`[${sessionId}] Webhook sent to ${webhookUrl}`);
                } catch (err) {
                    console.error(`[${sessionId}] Webhook failed:`, err.message);
                }
            }
        }
    });

    // Track message status updates (delivered, read, played)
    sock.ev.on('messages.update', async (updates) => {
        const sessionData = sessions.get(sessionId);
        const webhookUrl = sessionData?.webhookUrl || globalWebhookUrl;

        for (const update of updates) {
            const statusCode = update.update?.status;
            if (statusCode === undefined) continue;
            
            const statusName = STATUS_MAP[statusCode] || `unknown_${statusCode}`;
            const messageId = update.key?.id;
            const remoteJid = update.key?.remoteJid;

            // Store the status update
            if (messageId) {
                if (!messageStore.has(sessionId)) {
                    messageStore.set(sessionId, new Map());
                }
                const sessionMessages = messageStore.get(sessionId);
                const existingInfo = sessionMessages.get(messageId) || {};
                
                sessionMessages.set(messageId, {
                    ...existingInfo,
                    messageId,
                    remoteJid,
                    fromMe: update.key?.fromMe,
                    statusCode,
                    status: statusName,
                    updatedAt: Date.now(),
                    history: [
                        ...(existingInfo.history || []),
                        { statusCode, status: statusName, timestamp: Date.now() }
                    ]
                });
            }

            // Send webhook if configured
            if (webhookUrl) {
                try {
                    await fetch(webhookUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            event: 'messages.update',
                            sessionId,
                            data: {
                                messageId,
                                remoteJid,
                                fromMe: update.key?.fromMe,
                                statusCode,
                                status: statusName,
                                timestamp: Date.now()
                            }
                        })
                    });
                    console.log(`[${sessionId}] Message status update: ${messageId} -> ${statusName}`);
                } catch (err) {
                    console.error(`[${sessionId}] Status webhook failed:`, err.message);
                }
            } else {
                console.log(`[${sessionId}] Message status update: ${messageId} -> ${statusName}`);
            }
        }
    });

    // Add send message helper with status tracking
    sessions.get(sessionId).sendMessage = async (jid, content, options) => {
        const result = await sock.sendMessage(jid, content, options);
        
        // Store the sent message info in memory
        if (result?.key?.id) {
            if (!messageStore.has(sessionId)) {
                messageStore.set(sessionId, new Map());
            }
            messageStore.get(sessionId).set(result.key.id, {
                messageId: result.key.id,
                remoteJid: jid,
                fromMe: true,
                statusCode: 2,
                status: 'server_ack',
                sentAt: Date.now(),
                updatedAt: Date.now(),
                content: content,
                history: [{ statusCode: 2, status: 'server_ack', timestamp: Date.now() }]
            });

            // Persist to DB
            try {
                await prisma.message.create({
                    data: {
                        sessionId,
                        messageId: result.key.id,
                        remoteJid: jid,
                        fromMe: true,
                        messageType: content.text ? 'text' : content.image ? 'image' : 'other',
                        content: (content.text || content.caption || '').substring(0, 5000) || null,
                        status: 'server_ack',
                        timestamp: BigInt(Date.now()),
                    },
                });
            } catch (dbErr) {
                console.error(`[${sessionId}] DB save outgoing failed:`, dbErr.message);
            }
        }
        
        return result;
    }
    
    return sessions.get(sessionId);
};

const updateWebhook = async (sessionId, url) => {
    const session = sessions.get(sessionId);
    if (session) {
        session.webhookUrl = url;
    }
    
    try {
        await pool.query(
            'INSERT INTO session_store (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = ?',
            [`${sessionId}:webhook`, JSON.stringify({ url }), JSON.stringify({ url })]
        );
        return true;
    } catch (err) {
        console.error("Failed to save webhook to DB", err);
        return false;
    }
};

const getSession = (sessionId) => {
    return sessions.get(sessionId);
};

const getAllSessions = () => {
    const list = {};
    sessions.forEach((val, key) => {
        list[key] = {
            status: val.status,
            qr: val.qr,
            webhookUrl: val.webhookUrl || ''
        };
    });
    return list;
};

const deleteSession = async (sessionId) => {
    const session = sessions.get(sessionId);
    if (session) {
        if (session.sock) {
            try {
                if (session.status === 'connected') {
                    await session.sock.logout();
                } else {
                    session.sock.end(undefined);
                }
            } catch (err) {
                console.error(`[${sessionId}] Logout failed, forcing cleanup:`, err.message);
                try { session.sock.end(undefined); } catch(e) {}
            }
        }
        sessions.delete(sessionId);
    }
    // Clean up ALL session data from DB (auth keys, webhook, etc.)
    try {
        await pool.query('DELETE FROM session_store WHERE id LIKE ?', [`${sessionId}:%`]);
        await pool.query('DELETE FROM session_store WHERE id = ?', [sessionId]);
        console.log(`[${sessionId}] Session fully deleted from DB`);
    } catch(e) {
        console.error(`[${sessionId}] DB cleanup error:`, e.message);
    }
    // Also clean up memory stores
    messageStore.delete(sessionId);
    contactStore.delete(sessionId);
};

// Restore sessions from DB on startup
const restoreSessions = async () => {
    try {
        const [rows] = await pool.query('SELECT DISTINCT SUBSTRING_INDEX(id, ":", 1) as sessionId FROM session_store');
        for (const row of rows) {
          if (row.sessionId) {
            console.log(`Restoring session: ${row.sessionId}`);
            await createSession(row.sessionId);
            await delay(2000); // Stagger connections to avoid rate limiting
          }
        }
    } catch (err) {
        console.error("Error restoring sessions:", err);
    }
};

// Get status of a specific message
const getMessageStatus = (sessionId, messageId) => {
    const sessionMessages = messageStore.get(sessionId);
    if (!sessionMessages) return null;
    return sessionMessages.get(messageId) || null;
};

// Get all tracked messages for a session
const getSessionMessages = (sessionId, limit = 50) => {
    const sessionMessages = messageStore.get(sessionId);
    if (!sessionMessages) return [];
    
    const messages = Array.from(sessionMessages.values());
    // Sort by updatedAt descending and limit
    return messages
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit);
};

// Clear old messages (call periodically to prevent memory issues)
const cleanupOldMessages = (maxAgeMs = 24 * 60 * 60 * 1000) => { // Default: 24 hours
    const now = Date.now();
    let cleaned = 0;
    
    for (const [sessionId, messages] of messageStore) {
        for (const [messageId, info] of messages) {
            if (now - info.updatedAt > maxAgeMs) {
                messages.delete(messageId);
                cleaned++;
            }
        }
        if (messages.size === 0) {
            messageStore.delete(sessionId);
        }
    }
    
    if (cleaned > 0) {
        console.log(`Cleaned up ${cleaned} old message status entries`);
    }
};

// Run cleanup every hour
setInterval(() => cleanupOldMessages(), 60 * 60 * 1000);

// Helper to fetch profile picture with caching
const getProfilePictureWithCache = async (sock, jid) => {
    const cached = profilePicCache.get(jid);
    if (cached && (Date.now() - cached.fetchedAt) < PROFILE_PIC_CACHE_TTL) {
        return cached.url;
    }
    
    try {
        const url = await sock.profilePictureUrl(jid, 'image');
        profilePicCache.set(jid, { url, fetchedAt: Date.now() });
        return url;
    } catch (err) {
        // User might have privacy settings that hide profile pic
        profilePicCache.set(jid, { url: null, fetchedAt: Date.now() });
        return null;
    }
};

// Get profile picture for a contact (exported function)
const getProfilePicture = async (sessionId, jid) => {
    const session = sessions.get(sessionId);
    if (!session || !session.sock) {
        throw new Error('Session not found or not connected');
    }
    
    return await getProfilePictureWithCache(session.sock, jid);
};

// Clear profile picture cache (useful when user updates their picture)
const clearProfilePicCache = (jid = null) => {
    if (jid) {
        profilePicCache.delete(jid);
    } else {
        profilePicCache.clear();
    }
};

// Get contact info for a specific jid
const getContact = (sessionId, jid) => {
    const sessionContacts = contactStore.get(sessionId);
    if (!sessionContacts) return null;
    return sessionContacts.get(jid) || null;
};

// Get all contacts for a session
const getAllContacts = (sessionId) => {
    const sessionContacts = contactStore.get(sessionId);
    if (!sessionContacts) return [];
    return Array.from(sessionContacts.values());
};

// Mark messages as read (send read receipt / blue checkmarks)
const markAsRead = async (sessionId, messages) => {
    const session = sessions.get(sessionId);
    if (!session || !session.sock) {
        throw new Error('Session not found or not connected');
    }
    
    // messages should be an array of { remoteJid, id, participant? }
    // For individual chats: { remoteJid: "628123456789@s.whatsapp.net", id: "MESSAGE_ID" }
    // For groups: { remoteJid: "GROUP_JID@g.us", id: "MESSAGE_ID", participant: "SENDER_JID@s.whatsapp.net" }
    
    const keys = messages.map(msg => ({
        remoteJid: msg.remoteJid,
        id: msg.id,
        participant: msg.participant || undefined
    }));
    
    await session.sock.readMessages(keys);
    console.log(`[${sessionId}] Marked ${keys.length} message(s) as read`);
    
    return { success: true, count: keys.length };
};

// Send typing indicator (composing / paused)
const sendPresence = async (sessionId, jid, presence) => {
    const session = sessions.get(sessionId);
    if (!session || !session.sock) {
        throw new Error('Session not found or not connected');
    }
    
    // presence can be: 'composing', 'paused', 'recording', 'available', 'unavailable'
    await session.sock.sendPresenceUpdate(presence, jid);
    console.log(`[${sessionId}] Sent presence "${presence}" to ${jid}`);
    
    return { success: true, presence, jid };
};

// Download media from a message (images, videos, audio, documents)
const downloadMedia = async (sessionId, message) => {
    const session = sessions.get(sessionId);
    if (!session || !session.sock) {
        throw new Error('Session not found or not connected');
    }
    
    // Determine message type
    const messageContent = message.message;
    if (!messageContent) {
        throw new Error('No message content provided');
    }
    
    // Supported media types
    const mediaTypes = [
        'imageMessage',
        'videoMessage', 
        'audioMessage',
        'documentMessage',
        'stickerMessage'
    ];
    
    let mediaType = null;
    let mediaMessage = null;
    
    for (const type of mediaTypes) {
        if (messageContent[type]) {
            mediaType = type;
            mediaMessage = messageContent[type];
            break;
        }
    }
    
    if (!mediaType || !mediaMessage) {
        throw new Error('No downloadable media found in message');
    }
    
    try {
        // Download the media
        const buffer = await downloadMediaMessage(
            message,
            'buffer',
            {},
            {
                logger: console,
                reuploadRequest: session.sock.updateMediaMessage
            }
        );
        
        // Get media info
        const mimetype = mediaMessage.mimetype || 'application/octet-stream';
        const filename = mediaMessage.fileName || `media_${Date.now()}`;
        const filesize = mediaMessage.fileLength || buffer.length;
        
        return {
            success: true,
            mediaType: mediaType.replace('Message', ''),
            mimetype,
            filename,
            filesize,
            caption: mediaMessage.caption || null,
            base64: buffer.toString('base64'),
            // Also provide data URL for direct use in img/video tags
            dataUrl: `data:${mimetype};base64,${buffer.toString('base64')}`
        };
    } catch (error) {
        console.error(`[${sessionId}] Media download failed:`, error.message);
        throw new Error(`Failed to download media: ${error.message}`);
    }
};

// Get media type from message
const getMediaType = (message) => {
    if (!message?.message) return null;
    
    const mediaTypes = {
        imageMessage: 'image',
        videoMessage: 'video',
        audioMessage: 'audio',
        documentMessage: 'document',
        stickerMessage: 'sticker'
    };
    
    for (const [key, type] of Object.entries(mediaTypes)) {
        if (message.message[key]) {
            return {
                type,
                mimetype: message.message[key].mimetype,
                filename: message.message[key].fileName,
                caption: message.message[key].caption,
                filesize: message.message[key].fileLength,
                hasThumbnail: !!message.message[key].jpegThumbnail
            };
        }
    }
    
    return null;
};

export { 
    createSession, 
    getSession, 
    getAllSessions, 
    deleteSession, 
    restoreSessions, 
    updateWebhook, 
    getGlobalWebhook, 
    setGlobalWebhook, 
    initGlobalWebhook,
    getMessageStatus,
    getSessionMessages,
    STATUS_MAP,
    getProfilePicture,
    clearProfilePicCache,
    getContact,
    getAllContacts,
    markAsRead,
    sendPresence,
    downloadMedia,
    getMediaType
};
