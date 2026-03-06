import makeWASocket, { DisconnectReason, delay, downloadMediaMessage, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
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
const disconnectWebhookSent = new Set(); // prevent stacking disconnect webhooks

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

    // If session exists but not connected, close old socket first to prevent conflicts
    if (sessions.has(sessionId)) {
        const old = sessions.get(sessionId);
        if (old.sock) {
            try { old.sock.end(undefined); } catch(e) {}
        }
        sessions.delete(sessionId);
    }

    const { state, saveCreds } = await useMySQLAuthState(pool, sessionId);

    // Generate unique browser identity per session [platform, browser, version]
    const browsers = [
      ["Ubuntu", "Chrome", "131.0.6778.204"],
      ["Windows", "Edge", "131.0.2903.86"],
      ["macOS", "Safari", "18.2"],
      ["Windows", "Chrome", "131.0.6778.205"],
      ["Ubuntu", "Firefox", "133.0.3"],
      ["macOS", "Chrome", "131.0.6778.205"],
      ["Windows", "Firefox", "133.0.3"],
      ["Linux", "Chrome", "131.0.6778.204"],
    ];
    let hash = 0;
    for (let i = 0; i < sessionId.length; i++) hash = sessionId.charCodeAt(i) + ((hash << 5) - hash);
    const browser = browsers[Math.abs(hash) % browsers.length];

    // Fetch latest WA version to avoid 405/428 errors
    let version;
    try {
        const versionInfo = await fetchLatestBaileysVersion();
        version = versionInfo.version;
        console.log(`[${sessionId}] Using WA version: ${version}`);
    } catch (e) {
        version = [2, 3000, 1034195523]; // known working fallback
        console.log(`[${sessionId}] Version fetch failed, using fallback: ${version}`);
    }

    const sock = makeWASocket({
        logger: pino({ level: 'warn' }),
        printQRInTerminal: false,
        version,
        auth: state,
        defaultQueryTimeoutMs: 120_000,
        keepAliveIntervalMs: 30_000,
        browser,
        emitOwnEvents: true,
        markOnlineOnConnect: false,
        shouldSyncHistoryMessage: () => false,
        getMessage: async (key) => {
            // Required by Baileys for message retries and poll vote decryption
            try {
                const msg = await prisma.message.findFirst({
                    where: { sessionId, messageId: key.id, remoteJid: key.remoteJid },
                });
                if (msg?.content) return { conversation: msg.content };
            } catch(e) {}
            return undefined;
        },
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
            
            // Send disconnect webhook (once per disconnect, global only)
            if (globalWebhookUrl && !disconnectWebhookSent.has(sessionId)) {
                disconnectWebhookSent.add(sessionId);
                try {
                    const device = await prisma.device.findFirst({ where: { sessionId }, select: { name: true, phoneNumber: true } });
                    const reasonMap = { 401: 'loggedOut', 408: 'timedOut', 428: 'connectionClosed', 440: 'connectionReplaced', 500: 'badSession', 515: 'restartRequired' };
                    await fetch(globalWebhookUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            event: 'connection.close',
                            sessionId,
                            data: {
                                deviceName: device?.name || sessionId,
                                phoneNumber: device?.phoneNumber || null,
                                reason: reasonMap[statusCode] || errorMessage || 'unknown',
                                statusCode,
                                willReconnect: shouldReconnect,
                                timestamp: Date.now()
                            }
                        })
                    });
                } catch(e) {}
            }

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
            retryCount.delete(sessionId);
            disconnectWebhookSent.delete(sessionId); // reset so next disconnect fires webhook
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
                const data = {
                    jid: contact.id,
                    name: contact.name || contact.notify || null,
                    notify: contact.notify || null,
                    verifiedName: contact.verifiedName || null,
                    imgUrl: contact.imgUrl || null,
                    status: contact.status || null
                };
                // Store phone number if JID is @s.whatsapp.net
                if (contact.id.includes('@s.whatsapp.net')) {
                    data.phone = contact.id.split('@')[0].split(':')[0];
                }
                sessionContacts.set(contact.id, data);

                // Cross-reference LID ↔ phone JID
                if (contact.lid) {
                    const lidJid = contact.lid.includes('@') ? contact.lid : `${contact.lid}@lid`;
                    const existing = sessionContacts.get(lidJid) || {};
                    sessionContacts.set(lidJid, { ...existing, ...data, jid: lidJid, phoneJid: contact.id, phone: contact.id.split('@')[0].split(':')[0] });
                }
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

    // Store group metadata (subject/name) in contact store
    sock.ev.on('groups.upsert', (groups) => {
        if (!contactStore.has(sessionId)) {
            contactStore.set(sessionId, new Map());
        }
        const sessionContacts = contactStore.get(sessionId);
        for (const g of groups) {
            if (g.id) {
                const existing = sessionContacts.get(g.id) || {};
                sessionContacts.set(g.id, { ...existing, jid: g.id, name: g.subject || existing.name || null });
            }
        }
        console.log(`[${sessionId}] Groups upsert: ${groups.length} groups`);
    });

    sock.ev.on('groups.update', (updates) => {
        if (!contactStore.has(sessionId)) return;
        const sessionContacts = contactStore.get(sessionId);
        for (const g of updates) {
            if (g.id) {
                const existing = sessionContacts.get(g.id) || { jid: g.id };
                if (g.subject) existing.name = g.subject;
                sessionContacts.set(g.id, existing);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append') return;
        console.log(`[${sessionId}] messages.upsert: type=${type} count=${messages.length}`);
        {
            for (const msg of messages) {
                if (!msg.message) continue;

                const senderJid = msg.key?.remoteJid;
                // Skip status broadcasts and empty JIDs
                if (!senderJid || senderJid === 'status@broadcast') continue;

                // Resolve LID to phone number if possible
                if (senderJid.includes('@lid')) {
                    if (!contactStore.has(sessionId)) contactStore.set(sessionId, new Map());
                    const sc = contactStore.get(sessionId);
                    const existing = sc.get(senderJid);
                    if (!existing?.phone) {
                        try {
                            const pn = await sock.signalRepository.lidMapping.getPNForLID(senderJid);
                            if (pn) {
                                const phone = pn.split('@')[0].split(':')[0];
                                sc.set(senderJid, { ...(existing || {}), jid: senderJid, phoneJid: pn, phone });
                            }
                        } catch(e) {}
                    }
                }

                let contactName = null;

                if (senderJid && !msg.key?.fromMe) {
                    const sessionContacts = contactStore.get(sessionId);
                    if (sessionContacts && sessionContacts.has(senderJid)) {
                        const contact = sessionContacts.get(senderJid);
                        contactName = contact.name || contact.verifiedName || null;
                    }
                }

                // Lazy-fetch group name if not in contact store
                if (senderJid?.includes('@g.us')) {
                    if (!contactStore.has(sessionId)) contactStore.set(sessionId, new Map());
                    const sc = contactStore.get(sessionId);
                    if (!sc.has(senderJid) || !sc.get(senderJid).name) {
                        try {
                            const meta = await sock.groupMetadata(senderJid);
                            if (meta?.subject) {
                                sc.set(senderJid, { ...(sc.get(senderJid) || {}), jid: senderJid, name: meta.subject });
                            }
                        } catch(e) {}
                    }
                }

                // Determine message content and type
                let content = '';
                let messageType = 'text';
                const m = msg.message;

                // Skip internal system messages (only if they have NO real content)
                const mKeys = Object.keys(m);
                const systemOnly = mKeys.every(k => ['protocolMessage','senderKeyDistributionMessage','messageContextInfo','messageTimestamp'].includes(k));
                if (systemOnly) continue;

                if (m.conversation) { content = m.conversation; }
                else if (m.extendedTextMessage) { content = m.extendedTextMessage.text || ''; }
                else if (m.imageMessage) {
                    messageType = 'image';
                    content = m.imageMessage.caption || '';
                }
                else if (m.videoMessage) { messageType = 'video'; content = m.videoMessage.caption || ''; }
                else if (m.audioMessage) { messageType = m.audioMessage.ptt ? 'ptt' : 'audio'; }
                else if (m.documentMessage) { messageType = 'document'; content = m.documentMessage.fileName || ''; }
                else if (m.documentWithCaptionMessage) {
                    messageType = 'document';
                    const doc = m.documentWithCaptionMessage?.message?.documentMessage;
                    content = doc?.fileName || doc?.caption || '';
                }
                else if (m.stickerMessage) { messageType = 'sticker'; }
                else if (m.pttMessage) { messageType = 'ptt'; }
                else if (m.viewOnceMessage || m.viewOnceMessageV2) {
                    const inner = m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || {};
                    if (inner.imageMessage) { messageType = 'image'; content = inner.imageMessage.caption || ''; }
                    else if (inner.videoMessage) { messageType = 'video'; content = inner.videoMessage.caption || ''; }
                    else { messageType = 'image'; }
                }
                else if (m.reactionMessage) { continue; } // Skip reactions
                else { messageType = Object.keys(m)[0] || 'unknown'; }

                // Persist message to DB (skip duplicates)
                try {
                    const msgId = msg.key?.id || null;
                    // Check for duplicate
                    if (msgId) {
                        const exists = await prisma.message.findFirst({
                            where: { sessionId, messageId: msgId }
                        });
                        if (exists) continue;
                    }

                    // Store raw message for media types (needed for download)
                    const mediaTypes = ['image', 'video', 'audio', 'ptt', 'document', 'sticker'];
                    let rawMsg = null;
                    if (mediaTypes.includes(messageType)) {
                        try { rawMsg = JSON.stringify(msg); } catch(e) {}
                    }

                    // Resolve phone number
                    let senderPhone = null;
                    if (senderJid?.includes('@s.whatsapp.net')) {
                        senderPhone = senderJid.split('@')[0].split(':')[0];
                    } else if (senderJid?.includes('@lid')) {
                        const sc = contactStore.get(sessionId);
                        senderPhone = sc?.get(senderJid)?.phone || null;
                    }

                    const saved = await prisma.message.create({
                        data: {
                            sessionId,
                            messageId: msgId,
                            remoteJid: senderJid || null,
                            senderPhone,
                            fromMe: msg.key?.fromMe || false,
                            pushName: msg.pushName || null,
                            messageType,
                            content: content ? content.substring(0, 5000) : null,
                            rawMessage: rawMsg,
                            status: msg.key?.fromMe ? 'server_ack' : 'received',
                            timestamp: msg.messageTimestamp ? BigInt(msg.messageTimestamp) : null,
                        },
                    });

                    // Download and save media to local disk
                    if (mediaTypes.includes(messageType) && rawMsg) {
                        try {
                            const { default: fs } = await import('fs');
                            const { default: path } = await import('path');
                            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
                            const msgContent = msg.message;
                            const mediaKey = Object.keys(msgContent).find(k => k.includes('Message'));
                            const media = msgContent[mediaKey] || {};
                            const ext = (media.mimetype || 'application/octet-stream').split('/')[1]?.split(';')[0] || 'bin';
                            const mediaDir = path.join(process.cwd(), 'media', sessionId);
                            fs.mkdirSync(mediaDir, { recursive: true });
                            const filePath = path.join(mediaDir, `${saved.id}.${ext}`);
                            fs.writeFileSync(filePath, buffer);
                            // Save local path in DB
                            await prisma.message.update({
                                where: { id: saved.id },
                                data: { mediaPath: `media/${sessionId}/${saved.id}.${ext}` },
                            });
                        } catch(e) {
                            console.error(`[${sessionId}] Media save failed:`, e.message);
                        }
                    }

                    // Emit to Socket.IO for real-time chat
                    try {
                        const { getIO } = await import('./socket.js');
                        const io = getIO();
                        if (io) {
                            // Resolve target contact name for outgoing messages
                            let targetName = null;
                            if (msg.key?.fromMe && senderJid) {
                                const sc = contactStore.get(sessionId);
                                const ct = sc?.get(senderJid);
                                targetName = ct?.name || ct?.verifiedName || ct?.notify || null;
                            }
                            io.emit('new-message', {
                                id: Number(saved.id),
                                sessionId,
                                messageId: msg.key?.id || null,
                                remoteJid: senderJid,
                                fromMe: msg.key?.fromMe || false,
                                pushName: msg.pushName || null,
                                contactName: targetName,
                                messageType,
                                content: content ? content.substring(0, 5000) : null,
                                status: 'received',
                                createdAt: saved.createdAt,
                            });
                            console.log(`[${sessionId}] Socket.IO emitted new-message to ${senderJid}`);
                        }
                    } catch(e) {
                        console.error(`[${sessionId}] Socket.IO emit error:`, e.message);
                    }
                } catch (dbErr) {
                    console.error(`[${sessionId}] DB save failed:`, dbErr.message);
                }

                // Send webhook
                const sessionData = sessions.get(sessionId);
                const webhookUrl = sessionData?.webhookUrl || globalWebhookUrl;
                if (webhookUrl) {
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

                // Persist status to DB
                try {
                    await prisma.message.updateMany({
                        where: { sessionId, messageId },
                        data: { status: statusName }
                    });
                } catch(e) {}

                // Emit status update to frontend
                try {
                    const { getIO } = await import('./socket.js');
                    const io = getIO();
                    if (io) {
                        io.emit('message-status', {
                            sessionId, messageId, remoteJid,
                            status: statusName
                        });
                    }
                } catch(e) {}
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
                    // silently fail — webhook unreachable
                }
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

// Restore sessions from DB on startup — restore all except logged out/failed
const restoreSessions = async () => {
    try {
        // Restore all sessions that aren't explicitly logged out or failed
        const devices = await prisma.device.findMany({
          where: { status: { notIn: ['logged_out', 'failed'] } },
          select: { sessionId: true },
        });
        console.log(`Restoring ${devices.length} active sessions...`);
        for (const device of devices) {
          console.log(`Restoring session: ${device.sessionId}`);
          await createSession(device.sessionId);
          await delay(2000); // Stagger connections to avoid rate limiting
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

// Get all groups for a session
const getGroups = async (sessionId) => {
    const session = sessions.get(sessionId);
    if (!session || !session.sock || session.status !== 'connected') {
        throw new Error('Session not connected');
    }
    const groups = await session.sock.groupFetchAllParticipating();
    return Object.values(groups).map(g => ({
        id: g.id,
        subject: g.subject || '',
        size: g.participants?.length || 0,
    }));
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
    getMediaType,
    getGroups
};
