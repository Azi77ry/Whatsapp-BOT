/**
 * Knight Bot - Multi-Session Manager
 * Allows running 50+ concurrent WhatsApp bot instances with isolated auth and state
 */

const fs = require('fs');
const path = require('path');
const pino = require('pino');
const NodeCache = require('node-cache');
const EventEmitter = require('events');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    jidNormalizedUser,
    makeCacheableSignalKeyStore,
    delay
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');

const settings = require('../settings');
const { handleMessages, handleGroupParticipantUpdate, handleStatus } = require('../main');
const lightweightStore = require('./lightweight_store');

// Helper for Windows-safe directory deletion
async function safeDeleteFolder(folderPath, maxRetries = 5) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            if (fs.existsSync(folderPath)) {
                fs.rmSync(folderPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
            }
            return true;
        } catch (e) {
            await delay(400);
        }
    }
    return false;
}

class SessionManager extends EventEmitter {
    constructor() {
        super();
        this.sessions = new Map(); // sessionId -> { sock, config, status, qr, pairingCode, user, lastActive }
        this.sessionsDir = path.join(process.cwd(), 'sessions');
        this.dataFile = path.join(process.cwd(), 'data', 'sessions.json');
        this.logs = [];
        this.maxLogs = 150;
        this.stats = {
            totalMessages: 0,
            startTime: Date.now()
        };

        if (!fs.existsSync(this.sessionsDir)) {
            fs.mkdirSync(this.sessionsDir, { recursive: true });
        }

        this.loadSessionsData();
    }

    log(message, type = 'info', sessionId = null) {
        const entry = {
            id: Date.now() + Math.random().toString(36).substr(2, 4),
            timestamp: new Date().toISOString(),
            message,
            type,
            sessionId
        };
        this.logs.unshift(entry);
        if (this.logs.length > this.maxLogs) this.logs.pop();
        this.emit('log', entry);
    }

    loadSessionsData() {
        try {
            if (fs.existsSync(this.dataFile)) {
                const raw = fs.readFileSync(this.dataFile, 'utf8');
                this.savedConfigs = JSON.parse(raw);
            } else {
                this.savedConfigs = {};
                this.saveSessionsData();
            }
        } catch (e) {
            console.error('Failed to load sessions data:', e);
            this.savedConfigs = {};
        }
    }

    saveSessionsData() {
        try {
            const dataDir = path.dirname(this.dataFile);
            if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
            fs.writeFileSync(this.dataFile, JSON.stringify(this.savedConfigs, null, 2), 'utf8');
        } catch (e) {
            console.error('Failed to save sessions data:', e);
        }
    }

    getAllSessions() {
        const list = [];
        for (const [id, session] of this.sessions.entries()) {
            list.push({
                id,
                phoneNumber: session.config?.phoneNumber || session.user?.id?.split(':')[0] || 'N/A',
                name: session.config?.botName || settings.botName || 'Knight Bot',
                ownerName: session.config?.ownerName || settings.botOwner || 'Professor',
                ownerNumber: session.config?.ownerNumber || session.config?.phoneNumber || '',
                status: session.status || 'offline',
                isPaused: Boolean(session.isPaused),
                qr: session.qr || null,
                pairingCode: session.pairingCode || null,
                user: session.user || null,
                createdAt: session.config?.createdAt || new Date().toISOString(),
                lastActive: session.lastActive || new Date().toISOString(),
                autoRestart: session.config?.autoRestart !== false
            });
        }

        // Include saved configs that may be offline/inactive
        for (const [id, cfg] of Object.entries(this.savedConfigs)) {
            if (!this.sessions.has(id)) {
                list.push({
                    id,
                    phoneNumber: cfg.phoneNumber || 'N/A',
                    name: cfg.botName || settings.botName || 'Knight Bot',
                    ownerName: cfg.ownerName || settings.botOwner || 'Professor',
                    ownerNumber: cfg.ownerNumber || cfg.phoneNumber || '',
                    status: 'offline',
                    isPaused: Boolean(cfg.isPaused),
                    qr: null,
                    pairingCode: null,
                    user: cfg.user || null,
                    createdAt: cfg.createdAt || new Date().toISOString(),
                    lastActive: cfg.lastActive || null,
                    autoRestart: cfg.autoRestart !== false
                });
            }
        }
        return list;
    }

    getSession(sessionId) {
        if (this.sessions.has(sessionId)) {
            const s = this.sessions.get(sessionId);
            return {
                id: sessionId,
                phoneNumber: s.config?.phoneNumber || s.user?.id?.split(':')[0] || 'N/A',
                name: s.config?.botName || settings.botName,
                ownerName: s.config?.ownerName || settings.botOwner,
                ownerNumber: s.config?.ownerNumber || s.config?.phoneNumber || '',
                status: s.status,
                isPaused: Boolean(s.isPaused),
                qr: s.qr,
                pairingCode: s.pairingCode,
                user: s.user,
                createdAt: s.config?.createdAt,
                lastActive: s.lastActive,
                autoRestart: s.config?.autoRestart !== false
            };
        }
        if (this.savedConfigs[sessionId]) {
            const cfg = this.savedConfigs[sessionId];
            return {
                id: sessionId,
                phoneNumber: cfg.phoneNumber || 'N/A',
                name: cfg.botName || settings.botName,
                ownerName: cfg.ownerName || settings.botOwner,
                ownerNumber: cfg.ownerNumber || cfg.phoneNumber || '',
                status: 'offline',
                isPaused: Boolean(cfg.isPaused),
                qr: null,
                pairingCode: null,
                user: cfg.user || null,
                createdAt: cfg.createdAt,
                lastActive: cfg.lastActive,
                autoRestart: cfg.autoRestart !== false
            };
        }
        return null;
    }

    async createSession(sessionId, options = {}) {
        const {
            phoneNumber = '',
            botName = settings.botName || 'Knight Bot',
            ownerName = settings.botOwner || 'Professor',
            ownerNumber = phoneNumber,
            usePairingCode = true,
            autoRestart = true
        } = options;

        const cleanPhone = phoneNumber ? phoneNumber.replace(/[^0-9]/g, '') : '';

        const sessionConfig = {
            id: sessionId,
            phoneNumber: cleanPhone,
            botName,
            ownerName,
            ownerNumber: cleanPhone || ownerNumber,
            usePairingCode,
            autoRestart,
            isPaused: false,
            createdAt: this.savedConfigs[sessionId]?.createdAt || new Date().toISOString()
        };

        this.savedConfigs[sessionId] = sessionConfig;
        this.saveSessionsData();

        this.log(`Initializing session "${sessionId}" for ${cleanPhone || 'QR Mode'}`, 'info', sessionId);
        return await this.startSession(sessionId, sessionConfig);
    }

    async startSession(sessionId, config = null) {
        if (!config) {
            config = this.savedConfigs[sessionId] || {
                id: sessionId,
                botName: settings.botName,
                ownerName: settings.botOwner,
                usePairingCode: false,
                autoRestart: true
            };
        }

        // Close socket if already active
        if (this.sessions.has(sessionId)) {
            const existing = this.sessions.get(sessionId);
            if (existing.sock) {
                try {
                    existing.sock.ev.removeAllListeners();
                    existing.sock.end();
                } catch (e) {}
            }
        }

        const sessionFolder = path.join(this.sessionsDir, sessionId);
        if (!fs.existsSync(sessionFolder)) {
            fs.mkdirSync(sessionFolder, { recursive: true });
        }

        const sessionObj = {
            sock: null,
            config,
            status: 'connecting',
            isPaused: Boolean(config.isPaused),
            qr: null,
            pairingCode: null,
            user: config.user || null,
            lastActive: new Date().toISOString(),
            retryCount: 0
        };

        this.sessions.set(sessionId, sessionObj);
        this.emit('session_update', { id: sessionId, status: 'connecting' });

        try {
            const { version } = await fetchLatestBaileysVersion();
            const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
            const msgRetryCounterCache = new NodeCache();

            const isPairing = Boolean(config.usePairingCode && config.phoneNumber && !state.creds.registered);

            const sock = makeWASocket({
                version,
                logger: pino({ level: 'silent' }),
                printQRInTerminal: false,
                browser: ['Ubuntu', 'Chrome', '20.0.04'],
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' }))
                },
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: true,
                syncFullHistory: false,
                getMessage: async (key) => {
                    const jid = jidNormalizedUser(key.remoteJid);
                    const msg = await lightweightStore.loadMessage(jid, key.id);
                    return msg?.message || '';
                },
                msgRetryCounterCache,
                defaultQueryTimeoutMs: 60000,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 15000
            });

            sock.sessionConfig = config;
            sock.sessionId = sessionId;
            sessionObj.sock = sock;

            sock.ev.on('creds.update', async () => {
                await saveCreds();
            });

            if (isPairing) {
                setTimeout(async () => {
                    try {
                        let code = await sock.requestPairingCode(config.phoneNumber);
                        code = code?.match(/.{1,4}/g)?.join('-') || code;
                        sessionObj.pairingCode = code;
                        sessionObj.status = 'pairing';
                        this.log(`Pairing code generated for ${sessionId}: ${code}`, 'success', sessionId);
                        this.emit('session_update', { id: sessionId, status: 'pairing', pairingCode: code });
                    } catch (err) {
                        this.log(`Error requesting pairing code for ${sessionId}: ${err.message}`, 'error', sessionId);
                    }
                }, 3000);
            }

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    try {
                        const qrDataUrl = await QRCode.toDataURL(qr);
                        sessionObj.qr = qrDataUrl;
                        sessionObj.status = 'scan_qr';
                        this.emit('session_update', { id: sessionId, status: 'scan_qr', qr: qrDataUrl });
                    } catch (e) {
                        console.error('QR code generation error:', e);
                    }
                }

                if (connection === 'connecting') {
                    sessionObj.status = 'connecting';
                    this.emit('session_update', { id: sessionId, status: 'connecting' });
                }

                if (connection === 'open') {
                    sessionObj.status = 'online';
                    sessionObj.qr = null;
                    sessionObj.pairingCode = null;
                    sessionObj.user = sock.user;
                    sessionObj.lastActive = new Date().toISOString();
                    sessionObj.retryCount = 0;

                    this.savedConfigs[sessionId] = {
                        ...config,
                        user: sock.user,
                        lastActive: sessionObj.lastActive
                    };
                    this.saveSessionsData();

                    this.log(`Session "${sessionId}" connected successfully (${sock.user?.id})`, 'success', sessionId);
                    this.emit('session_update', { id: sessionId, status: 'online', user: sock.user });

                    try {
                        const botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                        await sock.sendMessage(botNumber, {
                            text: `🤖 *${config.botName || 'Knight Bot'} Connected!*\n\n` +
                                  `⚡ Session ID: ${sessionId}\n` +
                                  `⏰ Time: ${new Date().toLocaleString()}\n` +
                                  `✅ Status: Multi-Session Online & Ready!`
                        });
                    } catch (e) {}
                }

                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 401;

                    sessionObj.status = 'offline';
                    this.emit('session_update', { id: sessionId, status: 'offline', statusCode });
                    this.log(`Session "${sessionId}" closed. Reconnect: ${shouldReconnect}`, 'warn', sessionId);

                    if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                        this.log(`Session "${sessionId}" logged out. Clearing auth keys.`, 'error', sessionId);
                        await safeDeleteFolder(sessionFolder);
                        delete this.savedConfigs[sessionId]?.user;
                        this.saveSessionsData();
                    } else if (shouldReconnect && config.autoRestart !== false) {
                        sessionObj.retryCount = (sessionObj.retryCount || 0) + 1;
                        const delayMs = Math.min(sessionObj.retryCount * 5000, 30000);
                        this.log(`Reconnecting session "${sessionId}" in ${delayMs / 1000}s...`, 'info', sessionId);
                        await delay(delayMs);
                        this.startSession(sessionId, config);
                    }
                }
            });

            // Inbound messages
            sock.ev.on('messages.upsert', async (chatUpdate) => {
                if (sessionObj.isPaused) return; // Skip processing if bot is paused
                this.stats.totalMessages++;
                sessionObj.lastActive = new Date().toISOString();
                try {
                    const mek = chatUpdate.messages[0];
                    if (!mek?.message) return;

                    mek.message = (Object.keys(mek.message)[0] === 'ephemeralMessage') 
                        ? mek.message.ephemeralMessage.message 
                        : mek.message;

                    if (mek.key && mek.key.remoteJid === 'status@broadcast') {
                        await handleStatus(sock, chatUpdate);
                        return;
                    }

                    await handleMessages(sock, chatUpdate, false);
                } catch (err) {
                    console.error(`Error in messages.upsert for ${sessionId}:`, err);
                }
            });

            // Inbound group updates
            sock.ev.on('group-participants.update', async (update) => {
                if (sessionObj.isPaused) return;
                try {
                    await handleGroupParticipantUpdate(sock, update);
                } catch (err) {
                    console.error(`Error in group-participants.update for ${sessionId}:`, err);
                }
            });

            return {
                id: sessionId,
                status: sessionObj.status,
                config
            };
        } catch (error) {
            sessionObj.status = 'error';
            this.log(`Failed to start session "${sessionId}": ${error.message}`, 'error', sessionId);
            this.emit('session_update', { id: sessionId, status: 'error', error: error.message });
            throw error;
        }
    }

    async stopSession(sessionId) {
        if (this.sessions.has(sessionId)) {
            const session = this.sessions.get(sessionId);
            if (session.sock) {
                try {
                    session.sock.ev.removeAllListeners();
                    session.sock.end();
                } catch (e) {}
            }
            session.status = 'offline';
            this.emit('session_update', { id: sessionId, status: 'offline' });
            this.log(`Session "${sessionId}" stopped`, 'info', sessionId);
            return true;
        }
        return false;
    }

    async restartSession(sessionId) {
        this.log(`Restarting session "${sessionId}"`, 'info', sessionId);
        await this.stopSession(sessionId);
        await delay(1500);
        return await this.startSession(sessionId);
    }

    async deleteSession(sessionId) {
        this.log(`Deleting session "${sessionId}"`, 'warn', sessionId);
        await this.stopSession(sessionId);

        this.sessions.delete(sessionId);
        delete this.savedConfigs[sessionId];
        this.saveSessionsData();

        const folder = path.join(this.sessionsDir, sessionId);
        await safeDeleteFolder(folder);

        this.emit('session_deleted', { id: sessionId });
        return true;
    }

    // Toggle Pause/Resume bot processing
    togglePauseSession(sessionId) {
        const session = this.sessions.get(sessionId);
        const currentPaused = session ? session.isPaused : (this.savedConfigs[sessionId]?.isPaused || false);
        const newPaused = !currentPaused;

        if (session) session.isPaused = newPaused;
        if (this.savedConfigs[sessionId]) {
            this.savedConfigs[sessionId].isPaused = newPaused;
            this.saveSessionsData();
        }

        this.log(`Session "${sessionId}" is now ${newPaused ? 'PAUSED' : 'RESUMED'}`, 'info', sessionId);
        this.emit('session_update', { id: sessionId, isPaused: newPaused });
        return newPaused;
    }

    // Update Session Configuration
    async updateSessionConfig(sessionId, newConfig = {}) {
        if (!this.savedConfigs[sessionId]) {
            throw new Error('Session not found');
        }

        const updated = {
            ...this.savedConfigs[sessionId],
            botName: newConfig.botName || this.savedConfigs[sessionId].botName,
            ownerName: newConfig.ownerName || this.savedConfigs[sessionId].ownerName,
            ownerNumber: newConfig.ownerNumber || this.savedConfigs[sessionId].ownerNumber,
            autoRestart: typeof newConfig.autoRestart === 'boolean' ? newConfig.autoRestart : this.savedConfigs[sessionId].autoRestart
        };

        this.savedConfigs[sessionId] = updated;
        this.saveSessionsData();

        if (this.sessions.has(sessionId)) {
            const session = this.sessions.get(sessionId);
            session.config = updated;
            if (session.sock) session.sock.sessionConfig = updated;
        }

        this.log(`Updated configuration for session "${sessionId}"`, 'info', sessionId);
        return updated;
    }

    // Direct message sender from a specific connected bot
    async sendDirectMessage(sessionId, targetJid, textMessage) {
        const session = this.sessions.get(sessionId);
        if (!session || session.status !== 'online' || !session.sock) {
            throw new Error('Selected bot is offline or not found');
        }

        let cleanJid = targetJid.replace(/[^0-9]/g, '');
        if (!targetJid.includes('@')) {
            cleanJid = cleanJid + '@s.whatsapp.net';
        } else {
            cleanJid = targetJid;
        }

        const sent = await session.sock.sendMessage(cleanJid, { text: textMessage });
        this.log(`Direct message sent from "${sessionId}" to ${cleanJid}`, 'success', sessionId);
        return sent;
    }

    // Clean temp folder and orphan session folders
    async cleanSystem() {
        let cleanedFolders = 0;
        const tempDir = path.join(process.cwd(), 'temp');
        if (fs.existsSync(tempDir)) {
            try {
                const files = fs.readdirSync(tempDir);
                for (const f of files) {
                    try { fs.unlinkSync(path.join(tempDir, f)); } catch (e) {}
                }
            } catch (e) {}
        }

        // Clean orphan session folders (not in savedConfigs)
        if (fs.existsSync(this.sessionsDir)) {
            const dirs = fs.readdirSync(this.sessionsDir);
            for (const d of dirs) {
                if (!this.savedConfigs[d]) {
                    const full = path.join(this.sessionsDir, d);
                    await safeDeleteFolder(full);
                    cleanedFolders++;
                }
            }
        }

        this.log(`System cleanup completed. Removed ${cleanedFolders} orphan session folders.`, 'info');
        return { cleanedFolders };
    }

    async restoreAllSessions() {
        this.log('Restoring all saved sessions...', 'info');

        const sessionIds = Object.keys(this.savedConfigs);
        this.log(`Found ${sessionIds.length} saved session(s)`, 'info');

        for (const sessionId of sessionIds) {
            const config = this.savedConfigs[sessionId];
            try {
                await this.startSession(sessionId, config);
                await delay(1000);
            } catch (err) {
                this.log(`Failed to restore session "${sessionId}": ${err.message}`, 'error', sessionId);
            }
        }
    }

    async broadcast(messageText) {
        let sentCount = 0;
        let failCount = 0;

        for (const [id, session] of this.sessions.entries()) {
            if (session.status === 'online' && session.sock) {
                try {
                    if (session.sock.user?.id) {
                        const botNumber = session.sock.user.id.split(':')[0] + '@s.whatsapp.net';
                        await session.sock.sendMessage(botNumber, {
                            text: `📢 *GLOBAL BROADCAST:*\n\n${messageText}`
                        });
                        sentCount++;
                    }
                } catch (e) {
                    failCount++;
                }
            }
        }

        this.log(`Broadcast completed: ${sentCount} sent, ${failCount} failed`, 'info');
        return { sentCount, failCount };
    }

    getSystemStats() {
        const mem = process.memoryUsage();
        const activeSessions = Array.from(this.sessions.values()).filter(s => s.status === 'online').length;
        const pairingSessions = Array.from(this.sessions.values()).filter(s => s.status === 'pairing' || s.status === 'scan_qr').length;

        return {
            totalSessions: Object.keys(this.savedConfigs).length,
            activeOnline: activeSessions,
            pairing: pairingSessions,
            offline: Math.max(0, Object.keys(this.savedConfigs).length - activeSessions - pairingSessions),
            totalMessages: this.stats.totalMessages,
            uptimeSeconds: Math.floor((Date.now() - this.stats.startTime) / 1000),
            memory: {
                rssMB: (mem.rss / 1024 / 1024).toFixed(1),
                heapUsedMB: (mem.heapUsed / 1024 / 1024).toFixed(1),
                heapTotalMB: (mem.heapTotal / 1024 / 1024).toFixed(1)
            },
            nodeVersion: process.version,
            platform: process.platform
        };
    }
}

const sessionManager = new SessionManager();
module.exports = sessionManager;
