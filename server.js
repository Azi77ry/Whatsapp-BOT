/**
 * Knight Bot - High-Performance Multi-Session Web Server & Dashboard API
 * Uses Node.js native HTTP server with zero dependency hurdles
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// Auto-initialize required directories
const REQUIRED_DIRS = [
    path.join(__dirname, 'data'),
    path.join(__dirname, 'sessions'),
    path.join(__dirname, 'tmp'),
    path.join(__dirname, 'temp')
];
for (const dir of REQUIRED_DIRS) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

// Auto-initialize default data JSON files if missing
const DEFAULT_DATA_FILES = {
    'autoStatus.json': { enabled: true, reactOn: true },
    'messageCount.json': { isPublic: true },
    'banned.json': [],
    'warnings.json': {},
    'userGroupData.json': { antilink: {}, antibadword: {}, welcome: {}, goodbye: {}, chatbot: {}, antitag: {} },
    'antidelete.json': { enabled: true },
    'pmblocker.json': { enabled: false },
    'anticall.json': { enabled: false },
    'autoread.json': { enabled: false },
    'autotyping.json': { enabled: false },
    'owner.json': [],
    'premium.json': [],
    'sessions.json': []
};

for (const [file, defaultVal] of Object.entries(DEFAULT_DATA_FILES)) {
    const filePath = path.join(__dirname, 'data', file);
    if (!fs.existsSync(filePath)) {
        try {
            fs.writeFileSync(filePath, JSON.stringify(defaultVal, null, 2));
        } catch (e) {
            console.error(`Error initializing ${file}:`, e.message);
        }
    }
}

const settings = require('./settings');
const sessionManager = require('./lib/sessionManager');

const PORT = settings.port || process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Brute-force protection map: ip -> { count, lockedUntil }
const loginAttempts = new Map();
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

// MIME types dictionary for static file serving
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf'
};

// Helper to parse JSON body
function parseBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
            if (body.length > 1e6) req.destroy(); // 1MB limit
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                resolve({});
            }
        });
    });
}

// Helper to send JSON responses
function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end(JSON.stringify(data));
}

// Serve Static Assets
function serveStatic(req, res, pathname) {
    let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

    if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403);
        return res.end('Forbidden');
    }

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            // SPA fallback to index.html for non-API routes
            const indexFile = path.join(PUBLIC_DIR, 'index.html');
            fs.readFile(indexFile, (err2, content) => {
                if (err2) {
                    res.writeHead(404);
                    return res.end('404 Not Found');
                }
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(content);
            });
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        fs.readFile(filePath, (err, content) => {
            if (err) {
                res.writeHead(500);
                return res.end('Error loading file');
            }
            res.writeHead(200, {
                'Content-Type': contentType,
                'Cache-Control': 'public, max-age=3600'
            });
            res.end(content);
        });
    });
}

// Main Request Handler
async function handleRequest(req, res) {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const method = req.method.toUpperCase();

    // Handle CORS preflight
    if (method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        });
        return res.end();
    }

    // ==========================================
    // API ROUTES
    // ==========================================

    // Public Info & Support Details
    if (method === 'GET' && pathname === '/api/config/public') {
        return sendJson(res, 200, {
            success: true,
            botName: settings.botName || 'Knight Bot',
            botOwner: settings.botOwner || 'Professor',
            supportEmail: settings.supportEmail || 'support@knightbot.com',
            supportWhatsApp: settings.supportWhatsApp || '919876543210',
            supportTelegram: settings.supportTelegram || 'https://t.me/+3QhFUZHx-nhhZmY1',
            supportChannel: settings.supportChannel || 'https://whatsapp.com/channel/0029Va90zAnIHphOuO8Msp3A',
            version: settings.version || '3.0.7'
        });
    }

    // 1. Create Pairing Code Session
    if (method === 'POST' && pathname === '/api/sessions/create-pair') {
        const body = await parseBody(req);
        const { phoneNumber, botName, ownerName } = body;

        if (!phoneNumber) {
            return sendJson(res, 400, { success: false, error: 'Phone number is required' });
        }

        const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
        if (cleanPhone.length < 10) {
            return sendJson(res, 400, { success: false, error: 'Invalid international phone number' });
        }

        const sessionId = `knight_${cleanPhone}_${Date.now().toString(36)}`;
        try {
            const session = await sessionManager.createSession(sessionId, {
                phoneNumber: cleanPhone,
                botName: botName || settings.botName || 'Knight Bot',
                ownerName: ownerName || settings.botOwner || 'Professor',
                usePairingCode: true
            });

            return sendJson(res, 200, {
                success: true,
                sessionId,
                message: 'Pairing session initialized.',
                session
            });
        } catch (error) {
            return sendJson(res, 500, { success: false, error: error.message });
        }
    }

    // 2. Create QR Code Session
    if (method === 'POST' && pathname === '/api/sessions/create-qr') {
        const body = await parseBody(req);
        const { botName, ownerName } = body;
        const sessionId = `knight_qr_${Date.now().toString(36)}`;

        try {
            const session = await sessionManager.createSession(sessionId, {
                phoneNumber: '',
                botName: botName || settings.botName || 'Knight Bot',
                ownerName: ownerName || settings.botOwner || 'Professor',
                usePairingCode: false
            });

            return sendJson(res, 200, {
                success: true,
                sessionId,
                message: 'QR session initialized.',
                session
            });
        } catch (error) {
            return sendJson(res, 500, { success: false, error: error.message });
        }
    }

    // 3. Get Session Details
    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (method === 'GET' && sessionMatch) {
        const sessionId = sessionMatch[1];
        const session = sessionManager.getSession(sessionId);
        if (!session) {
            return sendJson(res, 404, { success: false, error: 'Session not found' });
        }
        return sendJson(res, 200, { success: true, session });
    }

    // 4. Real-time Server-Sent Events (SSE) stream for pairing
    const sseMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
    if (method === 'GET' && sseMatch) {
        const sessionId = sseMatch[1];

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });

        const current = sessionManager.getSession(sessionId);
        if (current) {
            res.write(`data: ${JSON.stringify({ type: 'init', session: current })}\n\n`);
        }

        const updateHandler = (data) => {
            if (data.id === sessionId) {
                const updated = sessionManager.getSession(sessionId);
                res.write(`data: ${JSON.stringify({ type: 'update', session: updated, event: data })}\n\n`);
            }
        };

        sessionManager.on('session_update', updateHandler);

        req.on('close', () => {
            sessionManager.off('session_update', updateHandler);
        });
        return;
    }

    // 5. Session Actions (Restart, Stop, Delete)
    const restartMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/restart$/);
    if (method === 'POST' && restartMatch) {
        try {
            await sessionManager.restartSession(restartMatch[1]);
            return sendJson(res, 200, { success: true, message: 'Session restarting...' });
        } catch (e) {
            return sendJson(res, 500, { success: false, error: e.message });
        }
    }

    const deleteMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/delete$/);
    if (method === 'POST' && deleteMatch) {
        try {
            await sessionManager.deleteSession(deleteMatch[1]);
            return sendJson(res, 200, { success: true, message: 'Session deleted.' });
        } catch (e) {
            return sendJson(res, 500, { success: false, error: e.message });
        }
    }

    // ==========================================
    // ADMIN API ROUTES
    // ==========================================

    // Admin Login with Brute-Force Rate Limiting
    if (method === 'POST' && pathname === '/api/admin/login') {
        const clientIp = req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        const record = loginAttempts.get(clientIp) || { count: 0, lockedUntil: 0 };

        if (record.lockedUntil > now) {
            const minutesLeft = Math.ceil((record.lockedUntil - now) / 60000);
            return sendJson(res, 429, {
                success: false,
                error: `Too many failed login attempts. IP temporarily blocked. Try again in ${minutesLeft} minute(s).`
            });
        }

        const body = await parseBody(req);
        const { username, password } = body;
        const validUser = settings.adminUsername || 'admin';
        const validPass = settings.adminPassword;

        if (username === validUser && password === validPass) {
            loginAttempts.delete(clientIp);
            return sendJson(res, 200, {
                success: true,
                token: validPass,
                user: { username: validUser }
            });
        }

        // Record failed attempt
        record.count = (record.count || 0) + 1;
        if (record.count >= MAX_FAILED_ATTEMPTS) {
            record.lockedUntil = now + LOCKOUT_DURATION_MS;
            loginAttempts.set(clientIp, record);
            return sendJson(res, 429, {
                success: false,
                error: 'Too many failed login attempts. Your IP has been locked for 15 minutes.'
            });
        }

        loginAttempts.set(clientIp, record);
        const attemptsRemaining = MAX_FAILED_ATTEMPTS - record.count;
        return sendJson(res, 401, {
            success: false,
            error: `Invalid credentials. (${attemptsRemaining} attempt(s) remaining)`
        });
    }

    // Helper to verify admin token
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace('Bearer ', '').trim();
    const isAdmin = token && token === settings.adminPassword;

    // Admin Sessions List
    if (method === 'GET' && pathname === '/api/admin/sessions') {
        if (!isAdmin) return sendJson(res, 401, { success: false, error: 'Unauthorized' });
        const sessions = sessionManager.getAllSessions();
        return sendJson(res, 200, { success: true, sessions });
    }

    // Admin Stats
    if (method === 'GET' && pathname === '/api/admin/stats') {
        if (!isAdmin) return sendJson(res, 401, { success: false, error: 'Unauthorized' });
        const stats = sessionManager.getSystemStats();
        return sendJson(res, 200, { success: true, stats });
    }

    // Admin Logs
    if (method === 'GET' && pathname === '/api/admin/logs') {
        if (!isAdmin) return sendJson(res, 401, { success: false, error: 'Unauthorized' });
        return sendJson(res, 200, { success: true, logs: sessionManager.logs });
    }

    // Admin Global Broadcast
    if (method === 'POST' && pathname === '/api/admin/broadcast') {
        if (!isAdmin) return sendJson(res, 401, { success: false, error: 'Unauthorized' });
        const body = await parseBody(req);
        if (!body.message || !body.message.trim()) {
            return sendJson(res, 400, { success: false, error: 'Broadcast message cannot be empty' });
        }
        const result = await sessionManager.broadcast(body.message.trim());
        return sendJson(res, 200, { success: true, result });
    }

    // Admin Pause / Resume Session
    const pauseMatch = pathname.match(/^\/api\/admin\/sessions\/([^/]+)\/pause$/);
    if (method === 'POST' && pauseMatch) {
        if (!isAdmin) return sendJson(res, 401, { success: false, error: 'Unauthorized' });
        const sessionId = pauseMatch[1];
        const isPaused = sessionManager.togglePauseSession(sessionId);
        return sendJson(res, 200, { success: true, isPaused, message: `Session ${isPaused ? 'paused' : 'resumed'}.` });
    }

    // Admin Update Session Config
    const configMatch = pathname.match(/^\/api\/admin\/sessions\/([^/]+)\/config$/);
    if (method === 'POST' && configMatch) {
        if (!isAdmin) return sendJson(res, 401, { success: false, error: 'Unauthorized' });
        const sessionId = configMatch[1];
        const body = await parseBody(req);
        try {
            const updated = await sessionManager.updateSessionConfig(sessionId, body);
            return sendJson(res, 200, { success: true, session: updated, message: 'Session configuration updated.' });
        } catch (e) {
            return sendJson(res, 400, { success: false, error: e.message });
        }
    }

    // Admin Direct WhatsApp Message Sender
    if (method === 'POST' && pathname === '/api/admin/send-message') {
        if (!isAdmin) return sendJson(res, 401, { success: false, error: 'Unauthorized' });
        const body = await parseBody(req);
        const { sessionId, targetJid, message } = body;

        if (!sessionId || !targetJid || !message) {
            return sendJson(res, 400, { success: false, error: 'Session ID, Target Number, and Message are required' });
        }

        try {
            const sent = await sessionManager.sendDirectMessage(sessionId, targetJid, message);
            return sendJson(res, 200, { success: true, message: 'Message sent successfully!', result: sent });
        } catch (e) {
            return sendJson(res, 500, { success: false, error: e.message });
        }
    }

    // Admin System Cleanup
    if (method === 'POST' && pathname === '/api/admin/cleanup') {
        if (!isAdmin) return sendJson(res, 401, { success: false, error: 'Unauthorized' });
        const result = await sessionManager.cleanSystem();
        return sendJson(res, 200, { success: true, message: 'System cleanup complete.', result });
    }

    // Admin Export All Sessions Backup
    if (method === 'GET' && pathname === '/api/admin/export') {
        if (!isAdmin) return sendJson(res, 401, { success: false, error: 'Unauthorized' });
        const exportPayload = {
            timestamp: new Date().toISOString(),
            stats: sessionManager.getSystemStats(),
            sessions: sessionManager.getAllSessions()
        };
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': 'attachment; filename="knight_sessions_backup.json"'
        });
        return res.end(JSON.stringify(exportPayload, null, 2));
    }

    // Fallback: Static File Serving (HTML/CSS/JS)
    if (method === 'GET') {
        return serveStatic(req, res, pathname);
    }

    return sendJson(res, 404, { success: false, error: 'Route not found' });
}

// Active Server Reference
let activeServer = null;

// Start Server with Resilient Port Fallback
function startServer(portToTry) {
    const srv = http.createServer(handleRequest);

    srv.listen(portToTry, async () => {
        activeServer = srv;
        console.log(`\n==================================================`);
        console.log(`🚀 Knight Bot Multi-Session Server Online!`);
        console.log(`🌐 Web Dashboard: http://localhost:${portToTry}`);
        console.log(`🛡️ Admin Login: Username: ${settings.adminUsername || 'admin'} | Password: ${settings.adminPassword}`);
        console.log(`==================================================\n`);

        // Auto-restore all saved sessions
        try {
            await sessionManager.restoreAllSessions();
        } catch (e) {
            console.error('Error during initial session restore:', e);
        }
    });

    srv.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.warn(`Port ${portToTry} is occupied, trying port ${portToTry + 1}...`);
            startServer(portToTry + 1);
        } else {
            console.error('Server error:', err);
        }
    });
}

startServer(PORT);

// Graceful process shutdown
process.on('SIGINT', () => {
    if (activeServer) {
        activeServer.close(() => process.exit(0));
    } else {
        process.exit(0);
    }
});
