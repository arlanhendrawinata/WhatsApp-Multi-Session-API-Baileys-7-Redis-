import 'dotenv/config'
import makeWASocket, { DisconnectReason, Browsers } from 'baileys'
import { useRedisAuthState, deleteKeysWithPattern } from 'baileys-redis-auth'
import Redis from 'ioredis';
import P from 'pino'
import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import QRCode from 'qrcode'
import cors from 'cors'

// Redis Client Configuration
const redisOptions = {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || '',
};

const mainRedis = new Redis(redisOptions);
mainRedis.on('connect', () => console.log('🔴 Redis Main Connected!'));
mainRedis.on('error', (err) => console.error('❌ Redis Error:', err.message));

const app = express()

const httpServer = createServer(app)
const io = new Server(httpServer, {
    cors: {
        origin: "*", // Untuk production, ganti dengan domain spesifik
        methods: ["GET", "POST"]
    }
})

app.use(cors({
    origin: '*',
}))
app.use(express.json())
const port = 3009

const sessions = {}

// Static delay helper
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Random delay generator (e.g., 3000ms to 7000ms)
const getRandomDelay = (min = 3000, max = 7000) => {
    return Math.floor(Math.random() * (max - min + 1)) + min;
};

// === WEBSOCKET HELPER FUNCTIONS ===

/**
 * Emit event to all clients that connected to spesific session
 */
function emitToSession(sessionId, event, data) {
    io.to(`session:${sessionId}`).emit(event, data);
}

/**
 * Broadcast status update to all clients
 */
function broadcastSessionStatus() {
    const activeSessions = Object.keys(sessions).map(id => ({
        id,
        connected: !!sessions[id]?.sock?.user,
        hasPairingCode: !!sessions[id]?.pairingCode,
        hasQR: !!sessions[id]?.qr,
        isConnecting: !!sessions[id] && !sessions[id]?.sock?.user,
        phoneNumber: sessions[id]?.sock?.user?.id?.split(':')[0] || null
    }));
    
    io.emit('sessions:update', activeSessions);
}


// --- CORE LOGIC ---
async function startSession(sessionId, phoneNumber = null) {
    // Initialize Redis Auth State
    const { state, saveCreds, redis: authRedis } = await useRedisAuthState(
        redisOptions,
        sessionId, // This prefix becomes the key name in Redis
        console.log // Internal logger
    )

    const sock = makeWASocket({
        logger: P({ level: 'silent' }),
        auth: state,
        // Using Ubuntu/Chrome for better Pairing Code stability
        browser: Browsers.ubuntu("Chrome"),
        syncFullHistory: false
    })

    sessions[sessionId] = { sock, qr: null, pairingCode: null }

    // Emit session created
    emitToSession(sessionId, 'session:created', { sessionId, method: phoneNumber ? 'pairing' : 'qr' });
    broadcastSessionStatus();

    // Pairing Code logic
    if (!sock.authState.creds.registered && phoneNumber) {
        setTimeout(async () => {
            try {
                const cleanNumber = phoneNumber.replace(/\D/g, '')
                const code = await sock.requestPairingCode(cleanNumber)
                sessions[sessionId].pairingCode = code
                console.log(`🔗 [${sessionId}] Pairing Code: ${code}`)

                // Emit pairing code via WebSocket
                emitToSession(sessionId, 'pairing:code', { 
                    sessionId, 
                    code,
                    phoneNumber: cleanNumber
                });
                broadcastSessionStatus();
            } catch (err) {
                console.error(`Failed to generate pairing code for ${sessionId}:`, err)
                emitToSession(sessionId, 'pairing:error', { 
                    sessionId, 
                    error: err.message 
                });
            }
        }, 5000)
    }

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update

        // Handle QR Code generation
        if (qr && !phoneNumber) {
            sessions[sessionId].qr = qr
            console.log(`[${sessionId}] QR available.`)

            try {
                // Generate QR as Data URL
                const qrDataURL = await QRCode.toDataURL(qr);
                
                // Emit QR code via WebSocket
                emitToSession(sessionId, 'qr:update', { 
                    sessionId, 
                    qr: qrDataURL 
                });
                
                console.log(await QRCode.toString(qr, { type: 'terminal', small: true }))
            } catch (err) {
                console.error('QR generation error:', err);
            }
            
            broadcastSessionStatus();
            // console.log(await QRCode.toString(qr, { type: 'terminal', small: true }))
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode
            const reason = lastDisconnect?.error?.output?.payload?.message || 'Unknown';

            // Emit disconnection event
            emitToSession(sessionId, 'connection:close', { 
                sessionId, 
                reason,
                statusCode,
                willReconnect: statusCode !== DisconnectReason.loggedOut
            });

            // Reconnect if not logged out manually
            if (statusCode !== DisconnectReason.loggedOut) {
                console.log(`🔄 [${sessionId}] Reconnecting...`)
                startSession(sessionId, phoneNumber)
            } else {
                console.log(`❌ [${sessionId}] Logged out. Cleaning up Redis data...`);

                try {
                    await deleteKeysWithPattern({
                        redis: authRedis,
                        pattern: `${sessionId}:*`
                    });
                    console.log(`🗑️ Data for ${sessionId} successfully deleted from Redis.`);
                    
                    // Emit logout event
                    emitToSession(sessionId, 'session:logout', { sessionId });
                } catch (delErr) {
                    console.error(`⚠️ Failed to delete Redis keys:`, delErr.message);
                }

                delete sessions[sessionId];
                broadcastSessionStatus();
            }
        } else if (connection === 'open') {
            sessions[sessionId].qr = null
            sessions[sessionId].pairingCode = null
            
            const userInfo = {
                sessionId,
                phoneNumber: sock.user.id.split(':')[0],
                name: sock.user.name || 'Unknown'
            };
            
            console.log(`✅ [${sessionId}] Connected!`, userInfo)
            
            // Emit connected event
            emitToSession(sessionId, 'connection:open', userInfo);
            broadcastSessionStatus();
        } else if (connection === 'connecting') {
            emitToSession(sessionId, 'connection:connecting', { sessionId });
            broadcastSessionStatus();
        }
    })

    // Listen to incoming messages (optional feature)
    // sock.ev.on('messages.upsert', async ({ messages, type }) => {
    //     for (const msg of messages) {
    //         if (type === 'notify' && !msg.key.fromMe) {
    //             const sender = msg.key.remoteJid;
    //             const text = msg.message?.conversation || 
    //                        msg.message?.extendedTextMessage?.text || '';
                
    //             // Emit incoming message via WebSocket
    //             emitToSession(sessionId, 'message:incoming', {
    //                 sessionId,
    //                 from: sender,
    //                 text,
    //                 timestamp: msg.messageTimestamp
    //             });
    //         }
    //     }
    // });
}

// === SESSION RESTORATION FROM REDIS ===
async function restoreSessions() {
    try {
        const keys = await mainRedis.keys('*:creds');
        console.log(`🔍 Debug: Found creds keys:`, keys);

        const sessionIds = keys.map(key => key.replace(':creds', ''));

        if (sessionIds.length === 0) {
            console.log("No active sessions found in Redis.");
            return;
        }

        console.log(`♻️  Restoring ${sessionIds.length} sessions: [${sessionIds.join(', ')}]`);

        for (const sessionId of sessionIds) {
            if (!sessions[sessionId]) {
                await startSession(sessionId);
                await new Promise(r => setTimeout(r, 2000));
            }
        }
        
        broadcastSessionStatus();
    } catch (err) {
        console.error("❌ Failed to restore sessions:", err);
    }
}

// === WEBSOCKET CONNECTION HANDLER ===
io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);
    
    // Send current sessions status on connect
    const activeSessions = Object.keys(sessions).map(id => ({
        id,
        connected: !!sessions[id]?.sock?.user,
        hasPairingCode: !!sessions[id]?.pairingCode,
        hasQR: !!sessions[id]?.qr,
        isConnecting: !!sessions[id] && !sessions[id]?.sock?.user,
        phoneNumber: sessions[id]?.sock?.user?.id?.split(':')[0] || null
    }));
    
    socket.emit('sessions:update', activeSessions);
    
    // Subscribe to specific session
    socket.on('subscribe:session', (sessionId) => {
        socket.join(`session:${sessionId}`);
        console.log(`📌 Client ${socket.id} subscribed to session: ${sessionId}`);
        
        // Send current session data
        const session = sessions[sessionId];
        if (session) {
            if (session.qr) {
                QRCode.toDataURL(session.qr).then(qrDataURL => {
                    socket.emit('qr:update', { sessionId, qr: qrDataURL });
                });
            }
            if (session.pairingCode) {
                socket.emit('pairing:code', { 
                    sessionId, 
                    code: session.pairingCode 
                });
            }
        }
    });
    
    // Unsubscribe from session
    socket.on('unsubscribe:session', (sessionId) => {
        socket.leave(`session:${sessionId}`);
        console.log(`📍 Client ${socket.id} unsubscribed from session: ${sessionId}`);
    });
    
    socket.on('disconnect', () => {
        console.log(`🔌 Client disconnected: ${socket.id}`);
    });
});

// --- API ENDPOINTS ---

/**
 * 1. Start Session (Supports QR & Pairing Code)
 * Example QR: /start/bot1
 * Example Pairing: /start/bot1?phone=62812345678
 */
app.get('/start/:id', async (req, res) => {
    const id = req.params.id
    const phone = req.query.phone // Get phone number from query string

    if (sessions[id]) {
        return res.json({ 
            message: `Session ${id} is already active.`,
            connected: !!sessions[id]?.sock?.user
        })
    }

    startSession(id, phone)

    const response = {
        sessionId: id,
        method: phone ? "Pairing Code" : "QR Code",
        message: phone ? `Requesting code for ${phone}...` : "Connect via WebSocket to receive QR.",
        websocket: `ws://localhost:${port}`,
        subscribeEvent: `subscribe:session with payload: "${id}"`
    }
    res.json(response)
})

/**
 * 2. Check Pairing Code
 */
app.get('/pairing-code/:id', (req, res) => {
    const session = sessions[req.params.id]
    if (!session) return res.status(404).json({ error: "Session not found" })
    res.json({ sessionId: req.params.id, code: session.pairingCode || "Not available yet" })
})

/**
 * 3. Get QR Code (REST fallback)
 */
app.get('/qr/:id', async (req, res) => {
    const session = sessions[req.params.id];
    
    if (!session) {
        return res.status(404).json({ error: "Session not found" });
    }
    
    if (!session.qr) {
        return res.status(404).json({ 
            error: "QR code not available yet. Use WebSocket for real-time updates." 
        });
    }
    
    try {
        const qrDataURL = await QRCode.toDataURL(session.qr);
        res.json({
            sessionId: req.params.id,
            qr: qrDataURL,
            status: "ready"
        });
    } catch (err) {
        res.status(500).json({ error: "Failed to generate QR code" });
    }
});

/**
 * 4. Session Status
 */
app.get('/status', (req, res) => {
    const activeSessions = Object.keys(sessions).map(id => ({
        id,
        connected: !!sessions[id]?.sock?.user,
        hasPairingCode: !!sessions[id]?.pairingCode,
        hasQR: !!sessions[id]?.qr,
        isConnecting: !!sessions[id] && !sessions[id]?.sock?.user,
        phoneNumber: sessions[id]?.sock?.user?.id?.split(':')[0] || null
    }))
    res.json(activeSessions)
})

/**
 * 4. Send Message (Anti-Ban version)
 */
app.post('/send-message', async (req, res) => {
    const sessionId = req.body.sessionId || req.body.session_id;
    const { number, message } = req.body;
    const session = sessions[sessionId];

    if (!session?.sock?.user) {
        return res.status(404).json({ error: "Session not active or not logged in." });
    }

    try {
        const jid = `${number.replace(/\D/g, '')}@s.whatsapp.net`;

        // 1. Send "Composing" status to appear natural
        await session.sock.sendPresenceUpdate('composing', jid);

        // 2. Simulate typing time (randomly between 1.5s - 4s based on message length)
        const typingTime = Math.min(Math.max(message.length * 50, 1500), 4000);
        await delay(typingTime);

        // 3. Send the actual message
        const result = await session.sock.sendMessage(jid, { text: message });

        // 4. Stop "Composing" status
        await session.sock.sendPresenceUpdate('paused', jid);

        // 5. Randomized post-delay to prevent mechanical patterns
        const postDelay = getRandomDelay(3000, 7000);
        console.log(`✅ [${sessionId}] Message sent to ${number}. Next delay: ${postDelay}ms`);

        // Emit message sent event
        emitToSession(sessionId, 'message:sent', {
            sessionId,
            to: number,
            message,
            timestamp: Date.now()
        });

        res.status(200).json({
            status: 'Success',
            to: number,
            next_delay_suggestion: postDelay
        });

    } catch (error) {
        console.error("Error sending message:", error);

        // Emit error event
        emitToSession(sessionId, 'message:error', {
            sessionId,
            error: error.message
        });

        res.status(500).json({ status: 'Error', error: error.message });
    }
});

/**
 * 6. Logout / Delete Session
 */
app.get('/logout/:id', async (req, res) => {
    const id = req.params.id;
    const session = sessions[id];

    if (session?.sock) {
        await session.sock.logout();
        res.json({ message: `Session ${id} successfully logged out.` });
    } else {
        const keys = await mainRedis.keys(`${id}:*`);
        if (keys.length > 0) await mainRedis.del(keys);
        delete sessions[id];
        broadcastSessionStatus();
        res.json({ message: `Session data for ${id} cleared from memory & Redis.` });
    }
});

// === MAIN ENTRY POINT ===
async function main() {
    try {
        console.log("🔴 Redis Connected!")

        await restoreSessions()

        httpServer.listen(port, () => {
            console.log(`🚀 API is running at http://localhost:${port}`)
            console.log(`🔌 WebSocket is running at ws://localhost:${port}`)
        })
    } catch (err) {
        console.error("Startup failed:", err)
        process.exit(1)
    }
}

main()