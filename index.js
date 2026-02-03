import 'dotenv/config'
import makeWASocket, { DisconnectReason, Browsers } from 'baileys'
import { useRedisAuthState, deleteKeysWithPattern } from 'baileys-redis-auth'
import Redis from 'ioredis';
import P from 'pino'
import express from 'express'
import QRCode from 'qrcode'

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
app.use(express.json())
const port = 3009

const sessions = {}

// Static delay helper
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Random delay generator (e.g., 3000ms to 7000ms)
const getRandomDelay = (min = 3000, max = 7000) => {
    return Math.floor(Math.random() * (max - min + 1)) + min;
};

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

    // Pairing Code logic
    if (!sock.authState.creds.registered && phoneNumber) {
        setTimeout(async () => {
            try {
                const cleanNumber = phoneNumber.replace(/\D/g, '')
                const code = await sock.requestPairingCode(cleanNumber)
                sessions[sessionId].pairingCode = code
                console.log(`🔗 [${sessionId}] Pairing Code: ${code}`)
            } catch (err) {
                console.error(`Failed to generate pairing code for ${sessionId}:`, err)
            }
        }, 5000)
    }

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update

        // Handle QR Code generation
        if (qr && !phoneNumber) {
            sessions[sessionId].qr = qr
            console.log(`[${sessionId}] QR available in terminal/API.`)
            console.log(await QRCode.toString(qr, { type: 'terminal', small: true }))
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode

            // Reconnect if not logged out manually
            if (statusCode !== DisconnectReason.loggedOut) {
                console.log(`🔄 [${sessionId}] Reconnecting...`)
                startSession(sessionId, phoneNumber)
            } else {
                console.log(`❌ [${sessionId}] Logged out. Cleaning up Redis data...`);

                try {
                    // Use pattern deletion for Simple mode (sessionId:*)
                    await deleteKeysWithPattern({
                        redis: authRedis,
                        pattern: `${sessionId}:*`
                    });
                    console.log(`🗑️ Data for ${sessionId} successfully deleted from Redis.`);
                } catch (delErr) {
                    console.error(`⚠️ Failed to delete Redis keys:`, delErr.message);
                }

                delete sessions[sessionId];
            }
        } else if (connection === 'open') {
            sessions[sessionId].qr = null
            sessions[sessionId].pairingCode = null
            console.log(`✅ [${sessionId}] Connected!`)
        }
    })
}

// --- SESSION RESTORATION FROM REDIS ---
async function restoreSessions() {
    try {
        // Search for all keys ending in ':creds' to find active sessions
        const keys = await mainRedis.keys('*:creds');

        console.log(`🔍 Debug: Found creds keys:`, keys);

        const sessionIds = keys.map(key => key.replace(':creds', ''));

        if (sessionIds.length === 0) {
            console.log("ℹ️ No active sessions found in Redis.");
            return;
        }

        console.log(`♻️  Restoring ${sessionIds.length} sessions: [${sessionIds.join(', ')}]`);

        for (const sessionId of sessionIds) {
            if (!sessions[sessionId]) {
                // Restore using the Simple mode auth handler
                await startSession(sessionId);
                // Delay between restorations to prevent connection spikes
                await new Promise(r => setTimeout(r, 2000));
            }
        }
    } catch (err) {
        console.error("❌ Failed to restore sessions:", err);
    }
}

// --- API ENDPOINTS ---

/**
 * 1. Start Session (Supports QR & Pairing Code)
 * Example QR: /start/bot1
 * Example Pairing: /start/bot1?phone=62812345678
 */
app.get('/start/:id', async (req, res) => {
    const id = req.params.id
    const phone = req.query.phone // Get phone number from query string

    if (sessions[id]) return res.json({ message: `Session ${id} is already active.` })

    startSession(id, phone)

    const response = {
        sessionId: id,
        method: phone ? "Pairing Code" : "QR Code",
        message: phone ? `Requesting code for ${phone}...` : "Check terminal to scan QR."
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
 * 3. Session Status
 */
app.get('/status', (req, res) => {
    const activeSessions = Object.keys(sessions).map(id => ({
        id,
        connected: !!sessions[id]?.sock?.user,
        hasPairingCode: !!sessions[id]?.pairingCode,
        isConnecting: !!sessions[id] && !sessions[id]?.sock?.user
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

        res.status(200).json({
            status: 'Success',
            to: number,
            next_delay_suggestion: postDelay
        });

    } catch (error) {
        console.error("Error sending message:", error);
        res.status(500).json({ status: 'Error', error: error.message });
    }
});

/**
 * 5. Logout / Delete Session
 */
app.get('/logout/:id', async (req, res) => {
    const id = req.params.id;
    const session = sessions[id];

    if (session?.sock) {
        // This triggers the 'close' event with reason loggedOut
        await session.sock.logout();
        res.json({ message: `Session ${id} successfully logged out.` });
    } else {
        // Fallback: manually clean Redis if socket is already gone
        const keys = await mainRedis.keys(`${id}:*`);
        if (keys.length > 0) await mainRedis.del(keys);
        delete sessions[id];
        res.json({ message: `Session data for ${id} cleared from memory & Redis.` });
    }
});

// --- MAIN ENTRY POINT ---
async function main() {
    try {
        console.log("🔴 Redis Connected!")

        // Automatically restore all sessions found in Redis
        await restoreSessions()

        app.listen(port, () => {
            console.log(`🚀 API is running at http://localhost:${port}`)
        })
    } catch (err) {
        console.error("Startup failed:", err)
        process.exit(1)
    }
}

main()