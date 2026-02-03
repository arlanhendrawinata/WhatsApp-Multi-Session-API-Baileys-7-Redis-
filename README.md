# WhatsApp Multi-Session API (Redis-Backed)

A robust WhatsApp API gateway built with Baileys v7+ and Redis for persistent session management. This project allows you to manage multiple WhatsApp accounts simultaneously with support for both QR Code and Pairing Code authentication.

## 🚀 Features

- **Multi-Session Support**: Manage multiple WhatsApp accounts in one instance.
- **Redis Auth Store**: Sessions survive server restarts via baileys-redis-auth.
- **Anti-Ban Logic**: Built-in human-like behavior (Typing status and randomized delays).
- **Authentication**: Support for legacy QR scanning and modern Pairing Codes (Phone number).
- **Auto-Restore**: Automatically reconnects all active sessions on server startup.

## 📋 Prerequisites

- **Node.js**: v20.20.0
- **pnpm**: 10.28.2
- **Redis**: Accessible instance (local or remote).

## 🛠️ Installation

Clone the repository and install dependencies:

```bash
pnpm install
```

**Environment Setup**: Create a `.env` file in the root directory:

```env
REDIS_HOST=your_redis_ip
REDIS_PORT=6379
REDIS_PASSWORD=your_redis_password
```

## 🖥️ Usage

Start the server:

```bash
pnpm start
```

## 📡 API Endpoints

### 1. Start a Session

Initialize a new session. If `phone` is provided, it requests a Pairing Code. If not, it generates a QR Code in the terminal.

- **URL**: `/start/:id`
- **Query Params**: `phone` (optional, e.g., 62812345678)
- **Example**: `GET http://localhost:3009/start/bot1?phone=62812345678`

### 2. Get Pairing Code

Retrieve the active pairing code if you requested authentication via phone number.

- **URL**: `/pairing-code/:id`
- **Example**: `GET http://localhost:3009/pairing-code/bot1`

### 3. Check Session Status

Get a list of all sessions and their connection states.

- **URL**: `/status`
- **Example**: `GET http://localhost:3009/status`

### 4. Send Message

Send a text message with simulated typing and anti-spam delays.

- **URL**: `/send-message`
- **Method**: `POST`
- **Body**:

```json
{
  "sessionId": "bot1",
  "number": "62812345678",
  "message": "Hello from the API!"
}
```

### 5. Logout

Disconnect the session and wipe all session data from Redis.

- **URL**: `/logout/:id`
- **Example**: `GET http://localhost:3009/logout/bot1`

## 🛡️ Anti-Ban Mechanics

This API implements several strategies to protect your account from being flagged as a bot:

- **Typing Simulation**: The bot triggers a composing (typing...) state for a duration based on the message length before actually sending.
- **Randomized Post-Delay**: After sending a message, the system logs a suggested delay (3s - 7s) to prevent rapid-fire messaging.
- **Ubuntu Chrome User-Agent**: Configured to mimic a standard browser on Ubuntu to improve pairing stability.

## 🏗️ Architecture Note

The system uses `useRedisAuthState` in Simple Mode.

- **Session Storage**: Each session ID creates multiple keys in Redis (e.g., `sess001:creds`, `sess001:pre-key-1`).
- **Cleanup**: When logging out, `deleteKeysWithPattern` is used to ensure all associated keys are purged using the `sessionId:*` wildcard.

## 🤝 Contributing

Feel free to open issues or submit pull requests to improve the anti-ban logic or session stability!