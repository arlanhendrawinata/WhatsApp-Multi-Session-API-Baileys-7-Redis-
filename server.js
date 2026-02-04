import 'dotenv/config'
import makeWASocket, { DisconnectReason, Browsers } from 'baileys'
import { useRedisAuthState, deleteKeysWithPattern } from 'baileys-redis-auth'
import Redis from 'ioredis'
import P from 'pino'
import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import QRCode from 'qrcode'
import cors from 'cors'

/* =====================================================
   CONFIG
===================================================== */

const PORT = 3009
const PENDING_EXPIRE_MS = 2 * 60 * 1000

const redisOptions = {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || ''
}

const mainRedis = new Redis(redisOptions)
mainRedis.on('connect', () => console.log('Redis Connected'))
mainRedis.on('error', e => console.error('Redis Error:', e.message))

/* =====================================================
   APP & SOCKET
===================================================== */

const app = express()
app.use(cors({ origin: '*' }))
app.use(express.json())

const httpServer = createServer(app)

const io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
})

/* =====================================================
   STATE
===================================================== */

const sessions = {}

/* =====================================================
   HELPERS
===================================================== */

const delay = ms => new Promise(r => setTimeout(r, ms))

function emitToSession(sessionId, event, data) {
    io.to(`session:${sessionId}`).emit(event, data)
}

function broadcastSessionStatus() {
    io.emit(
        'sessions:update',
        Object.entries(sessions).map(([id, s]) => ({
            id,
            status: s.status,
            connected: !!s.sock?.user,
            hasQR: !!s.qr,
            hasPairingCode: !!s.pairingCode,
            phoneNumber: s.sock?.user?.id?.split(':')[0] || null
        }))
    )
}

function waitForSessionData(sessionId, timeout = 4000) {
    return new Promise(resolve => {
        const start = Date.now()
        const i = setInterval(() => {
            const s = sessions[sessionId]
            if (!s) {
                clearInterval(i)
                return resolve(null)
            }

            if (s.qr || s.pairingCode || s.status === 'connected') {
                clearInterval(i)
                return resolve(s)
            }

            if (Date.now() - start > timeout) {
                clearInterval(i)
                resolve(s)
            }
        }, 300)
        
        // 🔧 FIX: Clear interval on timeout
        setTimeout(() => clearInterval(i), timeout + 500)
    })
}

function getExpireInfo(session) {
    if (!session || !session.status.startsWith('pending')) {
        return {
            expiresAt: null,
            expiresInMs: null
        }
    }

    const expiresAt = session.createdAt + PENDING_EXPIRE_MS
    return {
        expiresAt,
        expiresInMs: Math.max(0, expiresAt - Date.now())
    }
}

function getDisconnectReasonName(code) {
    const reasons = {
        428: 'connectionClosed',
        408: 'connectionLost/timedOut',
        440: 'connectionReplaced',
        500: 'badSession',
        401: 'loggedOut',
        515: 'restartRequired',
        411: 'multideviceMismatch',
        403: 'forbidden',
        503: 'unavailableService'
    }
    return reasons[code] || `unknown(${code})`
}

async function killSession(sessionId, reason = 'manual_kill') {
    const s = sessions[sessionId]
    if (!s) return false

    try {
        emitToSession(sessionId, 'session:killed', {
            sessionId,
            reason
        })

        // stop socket immediately
        await s.sock?.end?.()
        await s.sock?.logout?.()
    } catch (e) {
        console.warn(`killSession(${sessionId}) error:`, e.message)
    }

    // clear redis auth
    if (s.authRedis) {
        try {
            await deleteKeysWithPattern({
                redis: s.authRedis,
                pattern: `${sessionId}:*`
            })
        } catch (e) {
            console.warn(`Redis cleanup error for ${sessionId}:`, e.message)
        }
    }

    // remove memory
    delete sessions[sessionId]

    broadcastSessionStatus()
    return true
}

/* =====================================================
   CORE SESSION LOGIC
===================================================== */

async function startSession(sessionId, phoneNumber = null, force = false) {
    const existing = sessions[sessionId]

    if (existing && !force && existing.status === 'connected') {
        console.log(`✅ Session ${sessionId} already connected, skipping restart`)
        return
    }

    if (existing && force) {
        console.log(`🔄 Force restart session ${sessionId}`)
        try { 
            await existing.sock?.end()
        } catch (e) {
            console.warn(`Error ending socket:`, e.message)
        }
        delete sessions[sessionId]
    }

    const { state, saveCreds, redis: authRedis } =
        await useRedisAuthState(redisOptions, sessionId)

    const sock = makeWASocket({
        logger: P({ level: 'silent' }),
        auth: state,
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        // 🔧 FIX: Add reconnect options
        connectTimeoutMs: 60_000,
        defaultQueryTimeoutMs: 60_000,
        keepAliveIntervalMs: 30_000
    })


    sessions[sessionId] = {
        sock,
        status: phoneNumber ? 'pending_pair' : 'pending_qr',
        qr: null,
        pairingCode: null,
        createdAt: Date.now(),
        connectedAt: null,  // Track when connected
        phoneNumber,
        authRedis,
        reconnectAttempts: 0  // Track reconnect attempts
    }

    broadcastSessionStatus()
    sock.ev.on('creds.update', saveCreds)

    /* ---------- PAIRING ---------- */
    if (phoneNumber && !sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(
                    phoneNumber.replace(/\D/g, '')
                )
                sessions[sessionId].pairingCode = code
                emitToSession(sessionId, 'pairing:code', { sessionId, code })
                broadcastSessionStatus()
            } catch (e) {
                emitToSession(sessionId, 'pairing:error', {
                    sessionId,
                    error: e.message
                })
            }
        }, 1200)
    }

    /* ---------- CONNECTION UPDATE ---------- */
    sock.ev.on('connection.update', async u => {
        const s = sessions[sessionId]
        if (!s) return

        const { connection, qr, lastDisconnect } = u

        if (qr && s.status === 'pending_qr') {
            s.qr = qr
            emitToSession(sessionId, 'qr:update', {
                sessionId,
                qr: await QRCode.toDataURL(qr)
            })
            broadcastSessionStatus()
        }

        if (connection === 'open') {
            console.log(`Session ${sessionId} connected`)

            s.status = 'connected'
            s.connectedAt = Date.now()
            s.createdAt = Date.now() // Reset createdAt to avoid expiry issues
            s.qr = null
            s.pairingCode = null
            s.reconnectAttempts = 0

            emitToSession(sessionId, 'session:connected', {
                sessionId,
                phoneNumber: sock.user.id.split(':')[0]
            })

            broadcastSessionStatus()
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode
            const reason = lastDisconnect?.error?.output?.payload?.error
            const reasonName = getDisconnectReasonName(code)

            console.log(`Session ${sessionId} closed. Code: ${code} (${reasonName}), Reason: ${reason}`)

            const isLoggedOut = code === DisconnectReason.loggedOut
            const isConnectionLost = code === DisconnectReason.connectionLost
            const isTimedOut = code === DisconnectReason.timedOut
            const isConnectionClosed = code === DisconnectReason.connectionClosed
            const isBadSession = code === DisconnectReason.badSession

            if (isLoggedOut) {
                // User explicitly logged out - remove permanently
                console.log(`Session ${sessionId} logged out, removing permanently`)
                await deleteKeysWithPattern({
                    redis: s.authRedis,
                    pattern: `${sessionId}:*`
                })
                delete sessions[sessionId]
                broadcastSessionStatus()
                
            } else if (isBadSession) {
                // Bad session - remove and require re-login
                console.log(`Session ${sessionId} bad session, removing`)
                await deleteKeysWithPattern({
                    redis: s.authRedis,
                    pattern: `${sessionId}:*`
                })
                delete sessions[sessionId]
                broadcastSessionStatus()

            } else if (code === DisconnectReason.forbidden) {
                // 403 - Account banned or forbidden
                console.log(`Session ${sessionId} forbidden (403), removing`)
                await deleteKeysWithPattern({
                    redis: s.authRedis,
                    pattern: `${sessionId}:*`
                })
                delete sessions[sessionId]
                emitToSession(sessionId, 'session:forbidden', {
                    sessionId,
                    message: 'Account banned or forbidden by WhatsApp'
                })
                broadcastSessionStatus()

            } else if (code === DisconnectReason.multideviceMismatch) {
                // 411 - Multidevice mismatch, need re-authentication
                console.log(`Session ${sessionId} multidevice mismatch (411), removing`)
                await deleteKeysWithPattern({
                    redis: s.authRedis,
                    pattern: `${sessionId}:*`
                })
                delete sessions[sessionId]
                emitToSession(sessionId, 'session:multidevice_error', {
                    sessionId,
                    message: 'Multidevice mismatch - please re-authenticate'
                })
                broadcastSessionStatus()
                
            } else if (isConnectionLost || isTimedOut || isConnectionClosed) {
                // Temporary connection issues - try to reconnect
                s.reconnectAttempts = (s.reconnectAttempts || 0) + 1
                
                if (s.reconnectAttempts <= 5) {
                    console.log(`Session ${sessionId} reconnecting... (attempt ${s.reconnectAttempts}/5)`)
                    const backoff = Math.min(s.reconnectAttempts * 2000, 10000)
                    
                    setTimeout(() => {
                        if (sessions[sessionId]) {
                            startSession(sessionId, phoneNumber, true)
                        }
                    }, backoff)
                } else {
                    console.log(`Session ${sessionId} max reconnect attempts reached`)
                    await killSession(sessionId, 'max_reconnect_attempts')
                }

            } else if (code === DisconnectReason.connectionReplaced) {
                // 440 - Connection replaced by another session
                console.log(`Session ${sessionId} connection replaced (440), another device logged in`)
                await deleteKeysWithPattern({
                    redis: s.authRedis,
                    pattern: `${sessionId}:*`
                })
                delete sessions[sessionId]
                emitToSession(sessionId, 'session:replaced', {
                    sessionId,
                    message: 'Connection replaced by another device'
                })
                broadcastSessionStatus()

            } else if (code === DisconnectReason.restartRequired) {
                // 515 - Server requires restart
                console.log(`Session ${sessionId} restart required (515)`)
                
                if (s.isReconnecting) {
                    console.log(`Session ${sessionId} already reconnecting, skipping`)
                }
                
                s.isReconnecting = true
                setTimeout(() => {
                    if (sessions[sessionId] && !sessions[sessionId].isKilling) {
                        console.log(`Restarting session ${sessionId} as required by server`)
                        startSession(sessionId, phoneNumber, true)
                    }
                }, 2000)
            }

            if (code === DisconnectReason.unavailableService) {
                // 503 - Service temporarily unavailable
                console.log(`Session ${sessionId} service unavailable (503), waiting...`)
                
                if (s.isReconnecting) {
                    console.log(`Session ${sessionId} already reconnecting, skipping`)
                    return
                }
                
                s.isReconnecting = true
                s.reconnectAttempts = (s.reconnectAttempts || 0) + 1
                
                if (s.reconnectAttempts <= 5) {
                    const backoff = Math.min(s.reconnectAttempts * 5000, 30000) // Longer backoff for 503
                    console.log(`Retrying in ${backoff/1000}s... (attempt ${s.reconnectAttempts}/5)`)
                    
                    setTimeout(() => {
                        if (sessions[sessionId] && !sessions[sessionId].isKilling) {
                            startSession(sessionId, phoneNumber, true)
                        }
                    }, backoff)
                } else {
                    console.log(`Session ${sessionId} service unavailable after 5 attempts`)
                    await killSession(sessionId, 'service_unavailable')
                }
                
            } else {
                // Unknown disconnect - try reconnect once
                console.log(`Session ${sessionId} unknown disconnect, trying reconnect`)
                setTimeout(() => {
                    if (sessions[sessionId]) {
                        startSession(sessionId, phoneNumber, true)
                    }
                }, 3000)
            }
        }
    })
}

/* =====================================================
   AUTO EXPIRE PENDING (GLOBAL – OPTIMIZED)
===================================================== */

setInterval(() => {
    const now = Date.now()
    let changed = false

    for (const [id, s] of Object.entries(sessions)) {
        // Only expire pending sessions, NEVER connected ones
        if (s.status.startsWith('pending')) {
            const age = now - s.createdAt
            
            if (age > PENDING_EXPIRE_MS) {
                console.log(`Session ${id} (${s.status}) expired after ${Math.round(age/1000)}s`)
                s.sock?.end()
                delete sessions[id]
                changed = true
            }
        }
    }

    if (changed) broadcastSessionStatus()
}, 30_000)

/* =====================================================
   RESTORE SESSIONS FROM REDIS
===================================================== */

async function restoreSessions() {
    console.log('Restoring sessions from Redis...')
    const keys = await mainRedis.keys('*:creds')
    
    console.log(`Found ${keys.length} sessions in Redis`)
    
    for (const key of keys) {
        const id = key.replace(':creds', '')
        if (!sessions[id]) {
            console.log(`Restoring session: ${id}`)
            await startSession(id)
            await delay(1500)
        }
    }
    
    broadcastSessionStatus()
    console.log('Session restoration complete')
}

/* =====================================================
   SOCKET.IO
===================================================== */

io.on('connection', socket => {
    socket.emit('sessions:update',
        Object.entries(sessions).map(([id, s]) => ({
            id,
            status: s.status,
            phoneNumber: s.sock?.user?.id?.split(':')[0] || null,
            connected: s.status === 'connected',
            connectedAt: s.connectedAt
        }))
    )

    socket.on('subscribe:session', id => {
        socket.join(`session:${id}`)
        const s = sessions[id]
        if (s?.qr) {
            QRCode.toDataURL(s.qr).then(qr =>
                socket.emit('qr:update', { sessionId: id, qr })
            )
        }
        if (s?.pairingCode) {
            socket.emit('pairing:code', {
                sessionId: id,
                code: s.pairingCode
            })
        }
    })

    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`)
    })
})

/* =====================================================
   API
===================================================== */

app.get('/start/:id', async (req, res) => {
    const { id } = req.params
    const phone = req.query.phone

    console.log(`Start session request: ${id}${phone ? ` with phone ${phone}` : ''}`)

    if (!sessions[id]) {
        await startSession(id, phone)
    } else if (sessions[id].status === 'connected') {
        console.log(`Session ${id} already connected`)
    }

    const s = await waitForSessionData(id)
    const live = sessions[id]
    const expireInfo = getExpireInfo(live)

    res.json({
        sessionId: id,
        status: s?.status,
        qr: s?.qr ? await QRCode.toDataURL(s.qr) : null,
        pairingCode: s?.pairingCode || null,
        expiresAt: expireInfo.expiresAt,
        expiresInMs: expireInfo.expiresInMs,
        connectedAt: s?.connectedAt || null
    })
})

app.get('/status', (req, res) => {
    const data = Object.entries(sessions).map(([id, s]) => ({
        sessionId: id,
        status: s.status,               // pending_qr | pending_pair | connected
        connected: s.status === 'connected',
        hasQR: !!s.qr,
        hasPairingCode: !!s.pairingCode,
        phoneNumber: s.sock?.user?.id?.split(':')[0] || null,
        createdAt: s.createdAt,
        connectedAt: s.connectedAt || null,
        reconnectAttempts: s.reconnectAttempts || 0,
        expiresInMs: s.status.startsWith('pending')
            ? Math.max(0, PENDING_EXPIRE_MS - (Date.now() - s.createdAt))
            : null
    }))

    res.json({
        total: data.length,
        connected: data.filter(s => s.connected).length,
        pending: data.filter(s => s.status.startsWith('pending')).length,
        sessions: data
    })
})

app.post('/send-message', async (req, res) => {
    const sessionId = req.body.sessionId || req.body.session_id
    const { number, message } = req.body

    if (!sessionId || !number || !message) {
        return res.status(400).json({
            error: 'sessionId, number, and message are required'
        })
    }

    const session = sessions[sessionId]

    if (!session) {
        return res.status(404).json({
            error: 'Session not found',
            code: 'SESSION_NOT_FOUND'
        })
    }

    if (session.status !== 'connected' || !session.sock?.user) {
        return res.status(400).json({
            error: 'Session not connected',
            code: 'SESSION_NOT_CONNECTED',
            status: session.status
        })
    }

    try {
        const jid = `${number.replace(/\D/g, '')}@s.whatsapp.net`

        /* ---------- Human-like behavior ---------- */

        // typing indicator
        await session.sock.sendPresenceUpdate('composing', jid)

        // simulate typing delay (min 1.5s – max 4s)
        const typingDelay = Math.min(
            Math.max(message.length * 60, 1500),
            4000
        )
        await delay(typingDelay)

        // send message
        const result = await session.sock.sendMessage(jid, { text: message })

        // stop typing
        await session.sock.sendPresenceUpdate('paused', jid)

        /* ---------- WebSocket emit ---------- */

        emitToSession(sessionId, 'message:sent', {
            sessionId,
            to: number,
            message,
            messageId: result.key.id,
            timestamp: Date.now()
        })

        res.json({
            success: true,
            sessionId,
            to: number,
            messageId: result.key.id
        })
    } catch (err) {
        console.error(`Send message error for ${sessionId}:`, err.message)

        emitToSession(sessionId, 'message:error', {
            sessionId,
            error: err.message
        })

        res.status(500).json({
            success: false,
            error: err.message
        })
    }
})

app.post('/session/:id/refresh', async (req, res) => {
    const id = req.params.id
    const s = sessions[id]

    if (!s) return res.status(404).json({ 
        error: 'Session not found',
        code: 'SESSION_NOT_FOUND'
    })

    console.log(`Manual refresh for session ${id}`)
    await startSession(id, s.phoneNumber, true)
    const n = await waitForSessionData(id)

    res.json({
        sessionId: id,
        status: n?.status,
        qr: n?.qr ? await QRCode.toDataURL(n.qr) : null,
        pairingCode: n?.pairingCode || null
    })
})

app.delete('/session/:id', async (req, res) => {
    const id = req.params.id

    const ok = await killSession(id, 'api_delete')

    if (!ok) {
        return res.status(404).json({
            error: 'Session not found',
            code: 'SESSION_NOT_FOUND'
        })
    }

    res.json({
        success: true,
        sessionId: id,
        message: 'Session killed permanently'
    })
})

app.get('/logout/:id', async (req, res) => {
    const id = req.params.id
    const s = sessions[id]
    
    if (s) {
        console.log(`Logout session ${id}`)
        await s.sock?.logout()
        
        // Clean up Redis
        if (s.authRedis) {
            await deleteKeysWithPattern({
                redis: s.authRedis,
                pattern: `${id}:*`
            })
        }
        
        delete sessions[id]
        broadcastSessionStatus()
    }
    
    res.json({ 
        success: true,
        sessionId: id
    })
})

app.get('/health', (req, res) => {
    const totalSessions = Object.keys(sessions).length
    const connectedSessions = Object.values(sessions).filter(s => s.status === 'connected').length
    
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        sessions: {
            total: totalSessions,
            connected: connectedSessions,
            pending: totalSessions - connectedSessions
        }
    })
})

/* =====================================================
   BOOT
===================================================== */

async function main() {
    console.log('Starting Baileys Server...')
    await restoreSessions()
    httpServer.listen(PORT, () =>
        console.log(`Server running on http://localhost:${PORT}`)
    )
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down gracefully...')
    
    // Close all sessions
    for (const [id, s] of Object.entries(sessions)) {
        try {
            await s.sock?.end()
        } catch (e) {
            console.warn(`Error closing session ${id}:`, e.message)
        }
    }
    
    await mainRedis.quit()
    process.exit(0)
})

main()
