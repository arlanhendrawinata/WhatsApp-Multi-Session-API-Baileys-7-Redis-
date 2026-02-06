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

const isProduction = process.env.NODE_ENV === 'production'

const allowedOrigins = isProduction
  ? (process.env.CORS_ORIGIN || '').split(',').map(o => o.trim())
  : '*'

/* =====================================================
   CONFIG
===================================================== */

const PORT = 3009
const PENDING_EXPIRE_MS = 2 * 60 * 1000
const MAX_RECONNECT_ATTEMPTS = 5
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || '50')

const redisOptions = {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || '',
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    enableOfflineQueue: true
}

const mainRedis = new Redis(redisOptions)
mainRedis.on('connect', () => console.log('✓ Redis Connected'))
mainRedis.on('error', e => console.error('✗ Redis Error:', e.message))

/* =====================================================
   APP & SOCKET
===================================================== */

const app = express()

app.use(cors({
  origin: (origin, callback) => {
    if (!isProduction) return callback(null, true)
    if (!origin) return callback(null, true)
    if (allowedOrigins.includes(origin)) return callback(null, true)
    return callback(new Error('Not allowed by CORS'))
  },
  credentials: true
}))

app.use(express.json())

const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: isProduction ? allowedOrigins : '*',
    methods: ['GET', 'POST'],
    credentials: true
  },
  maxHttpBufferSize: 1e6,
  pingInterval: 25000,
  pingTimeout: 60000
})

/* =====================================================
   STATE
===================================================== */

const sessions = {}
const sessionTimers = {} // Track all timers for cleanup

/* =====================================================
   HELPERS
===================================================== */

const delay = ms => new Promise(r => setTimeout(r, ms))

function emitToSession(sessionId, event, data) {
    io.to(`session:${sessionId}`).emit(event, data)
}

function broadcastSessionStatus() {
    io.emit('sessions:update',
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

function clearSessionTimers(sessionId) {
    if (sessionTimers[sessionId]) {
        sessionTimers[sessionId].forEach(timer => clearTimeout(timer))
        delete sessionTimers[sessionId]
    }
}

function addSessionTimer(sessionId, timer) {
    if (!sessionTimers[sessionId]) sessionTimers[sessionId] = []
    sessionTimers[sessionId].push(timer)
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
        
        const cleanup = setTimeout(() => clearInterval(i), timeout + 500)
        addSessionTimer(sessionId, cleanup)
    })
}

function getExpireInfo(session) {
    if (!session || !session.status.startsWith('pending')) {
        return { expiresAt: null, expiresInMs: null }
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
        408: 'connectionLost',
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

async function cleanupSessionRedis(sessionId, authRedis) {
    try {
        await deleteKeysWithPattern({
            redis: authRedis,
            pattern: `${sessionId}:*`
        })
    } catch (e) {
        console.warn(`Redis cleanup error for ${sessionId}:`, e.message)
    }
}

async function cleanupSessionSocket(sock) {
    if (!sock) return
    try {
        // Remove all listeners to prevent memory leaks
        sock.ev.removeAllListeners()
        sock.removeAllListeners()
        await sock.end?.()
    } catch (e) {
        console.warn('Socket cleanup error:', e.message)
    }
}

async function killSession(sessionId, reason = 'manual_kill') {
    const s = sessions[sessionId]
    if (!s) return false

    console.log(`🔴 Killing session ${sessionId} (${reason})`)

    try {
        emitToSession(sessionId, 'session:killed', { sessionId, reason })
        await cleanupSessionSocket(s.sock)
        await cleanupSessionRedis(sessionId, s.authRedis)
    } catch (e) {
        console.warn(`killSession(${sessionId}) error:`, e.message)
    }

    clearSessionTimers(sessionId)
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
        return
    }

    // Prevent creating too many sessions
    const activeSessions = Object.values(sessions).length
    if (!existing && activeSessions >= MAX_SESSIONS) {
        console.warn(`⚠️ Max sessions (${MAX_SESSIONS}) reached`)
        return
    }

    if (existing && force) {
        console.log(`🔄 Force restart session ${sessionId}`)
        try {
            await cleanupSessionSocket(existing.sock)
        } catch (e) {
            console.warn(`Error ending socket:`, e.message)
        }
        clearSessionTimers(sessionId)
        delete sessions[sessionId]
    }

    const { state, saveCreds, redis: authRedis } =
        await useRedisAuthState(redisOptions, sessionId)

    const sock = makeWASocket({
        logger: P({ level: 'silent' }),
        auth: state,
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        connectTimeoutMs: 60_000,
        defaultQueryTimeoutMs: 60_000,
        keepAliveIntervalMs: 30_000,
        retryRequestDelayMs: 250,
        maxMsgsInMemory: 10  // Prevent memory bloat
    })

    sessions[sessionId] = {
        sock,
        status: phoneNumber ? 'pending_pair' : 'pending_qr',
        qr: null,
        pairingCode: null,
        createdAt: Date.now(),
        connectedAt: null,
        phoneNumber,
        authRedis,
        reconnectAttempts: 0,
        isReconnecting: false,
        listeners: { creds: null, connection: null }  // Track listeners
    }

    broadcastSessionStatus()

    // Event Listener: Credentials Update
    const credsListener = saveCreds
    sessions[sessionId].listeners.creds = credsListener
    sock.ev.on('creds.update', credsListener)

    // Pairing Code Handler
    if (phoneNumber && !sock.authState.creds.registered) {
        const pairingTimer = setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(
                    phoneNumber.replace(/\D/g, '')
                )
                const s = sessions[sessionId]
                if (s) {
                    s.pairingCode = code
                    emitToSession(sessionId, 'pairing:code', { sessionId, code })
                    broadcastSessionStatus()
                }
            } catch (e) {
                emitToSession(sessionId, 'pairing:error', {
                    sessionId,
                    error: e.message
                })
            }
        }, 1200)
        addSessionTimer(sessionId, pairingTimer)
    }

    // Event Listener: Connection Update
    const connectionListener = async u => {
        const s = sessions[sessionId]
        if (!s) return

        const { connection, qr, lastDisconnect } = u

        // QR Code
        if (qr && s.status === 'pending_qr') {
            s.qr = qr
            try {
                const qrDataUrl = await QRCode.toDataURL(qr)
                emitToSession(sessionId, 'qr:update', { sessionId, qr: qrDataUrl })
                broadcastSessionStatus()
            } catch (e) {
                console.warn(`QR generation error:`, e.message)
            }
        }

        // Connected
        if (connection === 'open') {
            console.log(`✅ Session ${sessionId} connected`)

            s.status = 'connected'
            s.connectedAt = Date.now()
            s.createdAt = Date.now()
            s.qr = null
            s.pairingCode = null
            s.reconnectAttempts = 0
            s.isReconnecting = false

            emitToSession(sessionId, 'session:connected', {
                sessionId,
                phoneNumber: sock.user.id.split(':')[0]
            })

            broadcastSessionStatus()
            return
        }

        // Disconnected
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode
            const reasonName = getDisconnectReasonName(code)

            console.log(`Session ${sessionId} closed. Code: ${code} (${reasonName})`)

            // Prevent double-handling
            if (s.isReconnecting) return

            const isLoggedOut = code === DisconnectReason.loggedOut
            const isConnectionLost = code === DisconnectReason.connectionLost
            const isTimedOut = code === DisconnectReason.timedOut
            const isConnectionClosed = code === DisconnectReason.connectionClosed
            const isBadSession = code === DisconnectReason.badSession
            const isForbidden = code === DisconnectReason.forbidden
            const isMultideviceMismatch = code === DisconnectReason.multideviceMismatch
            const isConnectionReplaced = code === DisconnectReason.connectionReplaced
            const isRestartRequired = code === DisconnectReason.restartRequired
            const isUnavailableService = code === DisconnectReason.unavailableService

            // Terminal errors
            if (isLoggedOut || isBadSession || isForbidden || isMultideviceMismatch || isConnectionReplaced) {
                console.log(`Session ${sessionId} terminal error, killing`)
                await killSession(sessionId, `terminal_${reasonName}`)
                return
            }

            // Temporary errors - reconnect with backoff
            if (isConnectionLost || isTimedOut || isConnectionClosed || isUnavailableService) {
                s.reconnectAttempts = (s.reconnectAttempts || 0) + 1

                if (s.reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
                    const baseBackoff = isUnavailableService ? 5000 : 2000
                    const backoff = Math.min(s.reconnectAttempts * baseBackoff, 30000)

                    console.log(`Session ${sessionId} reconnecting (${s.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`)

                    s.isReconnecting = true
                    const timer = setTimeout(() => {
                        if (sessions[sessionId] && !sessions[sessionId].isReconnecting) {
                            s.isReconnecting = false
                            startSession(sessionId, phoneNumber, true)
                        }
                    }, backoff)
                    addSessionTimer(sessionId, timer)
                    return
                } else {
                    await killSession(sessionId, 'max_reconnect_attempts')
                    return
                }
            }

            // Restart required
            if (isRestartRequired) {
                console.log(`Session ${sessionId} restart required`)
                s.isReconnecting = true
                const timer = setTimeout(() => {
                    if (sessions[sessionId]) {
                        s.isReconnecting = false
                        startSession(sessionId, phoneNumber, true)
                    }
                }, 2000)
                addSessionTimer(sessionId, timer)
                return
            }

            // Unknown - don't reconnect
            console.log(`Session ${sessionId} unknown disconnect, not reconnecting`)
        }
    }

    sessions[sessionId].listeners.connection = connectionListener
    sock.ev.on('connection.update', connectionListener)
}

/* =====================================================
   AUTO EXPIRE PENDING
===================================================== */

setInterval(() => {
    const now = Date.now()
    let changed = false

    for (const [id, s] of Object.entries(sessions)) {
        if (s.status.startsWith('pending')) {
            const age = now - s.createdAt

            if (age > PENDING_EXPIRE_MS) {
                console.log(`Session ${id} expired after ${Math.round(age / 1000)}s`)
                killSession(id, 'pending_expired')
                changed = true
            }
        }
    }

    if (changed) broadcastSessionStatus()
}, 30_000)

/* =====================================================
   MEMORY OPTIMIZATION
===================================================== */

setInterval(() => {
    const used = process.memoryUsage()
    const heapUsedMB = Math.round(used.heapUsed / 1024 / 1024)
    const heapTotalMB = Math.round(used.heapTotal / 1024 / 1024)

    console.log(`📊 Memory: ${heapUsedMB}MB / ${heapTotalMB}MB | Sessions: ${Object.keys(sessions).length}`)

    // Force GC if memory is high (optional - requires --expose-gc flag)
    if (heapUsedMB > 400 && global.gc) {
        console.log('🧹 Forcing garbage collection...')
        global.gc()
    }
}, 60_000)

/* =====================================================
   RESTORE SESSIONS FROM REDIS
===================================================== */

async function restoreSessions() {
    console.log('🔄 Restoring sessions from Redis...')
    try {
        const keys = await mainRedis.keys('*:creds')
        console.log(`Found ${keys.length} sessions in Redis`)

        for (const key of keys) {
            const id = key.replace(':creds', '')
            if (!sessions[id] && Object.keys(sessions).length < MAX_SESSIONS) {
                console.log(`Restoring: ${id}`)
                await startSession(id)
                await delay(1500)
            }
        }
    } catch (e) {
        console.error('Session restoration error:', e.message)
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
   API ENDPOINTS
===================================================== */

app.get('/start/:id', async (req, res) => {
    const { id } = req.params
    const phone = req.query.phone

    if (!sessions[id]) {
        await startSession(id, phone)
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
        status: s.status,
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
        sessions: data,
        memory: process.memoryUsage()
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

        await session.sock.sendPresenceUpdate('composing', jid)

        const typingDelay = Math.min(
            Math.max(message.length * 60, 1500),
            4000
        )
        await delay(typingDelay)

        const result = await session.sock.sendMessage(jid, { text: message })

        await session.sock.sendPresenceUpdate('paused', jid)

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
        await s.sock?.logout()
        await cleanupSessionRedis(id, s.authRedis)
        clearSessionTimers(id)
        delete sessions[id]
        broadcastSessionStatus()
    }

    res.json({
        success: true,
        sessionId: id
    })
})

app.get('/health', (req, res) => {
    const used = process.memoryUsage()
    const totalSessions = Object.keys(sessions).length
    const connectedSessions = Object.values(sessions).filter(s => s.status === 'connected').length

    res.json({
        status: 'ok',
        uptime: process.uptime(),
        memory: {
            heapUsedMB: Math.round(used.heapUsed / 1024 / 1024),
            heapTotalMB: Math.round(used.heapTotal / 1024 / 1024),
            external: Math.round(used.external / 1024 / 1024)
        },
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
    console.log('🚀 Starting Baileys Server...')
    await restoreSessions()
    httpServer.listen(PORT, () => {
        console.log(`✓ Server running on http://localhost:${PORT}`)
    })
}

// Graceful Shutdown
process.on('SIGINT', async () => {
    console.log('\n⏹️  Shutting down gracefully...')

    for (const [id, s] of Object.entries(sessions)) {
        try {
            clearSessionTimers(id)
            await cleanupSessionSocket(s.sock)
        } catch (e) {
            console.warn(`Error closing session ${id}:`, e.message)
        }
    }

    await mainRedis.quit()
    process.exit(0)
})

process.on('SIGTERM', async () => {
    console.log('\n⏹️  SIGTERM received, shutting down...')
    process.emit('SIGINT')
})

main()
