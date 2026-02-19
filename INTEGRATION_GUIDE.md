# WhatsApp Baileys Service Integration Documentation

This service provides a multi-session WhatsApp API with MySQL session storage and Webhook capabilities.

## 1. Setup

### Prerequisites
- Node.js (v18+)
- MySQL Database

### Installation
1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a MySQL database (e.g., `whatsapp_baileys`).
4. Configure `.env` file:
   ```env
   DB_HOST=localhost
   DB_USER=root
   DB_PASSWORD=
   DB_NAME=whatsapp_baileys
   DB_PORT=3306
   PORT=3000
   WEBHOOK_URL=http://your-backend-api.com/webhook
   ```
5. Run the service:
   ```bash
   npm run dev
   ```

## 2. API Endpoints

Base URL: `http://localhost:3000`

### Manage Sessions

#### Create/Initialize a Session
Creates a new WhatsApp session. If it doesn't exist, it prepares for QR scanning.
- **Endpoint**: `POST /api/sessions`
- **Body**:
  ```json
  {
      "sessionId": "my-device-1"
  }
  ```
- **Response**:
  ```json
  {
      "message": "Session initialization started",
      "sessionId": "my-device-1"
  }
  ```

#### Get All Sessions
Lists all active sessions and their status.
- **Endpoint**: `GET /api/sessions`
- **Response**:
  ```json
  {
      "my-device-1": {
          "status": "connected",
          "qr": null
      },
      "my-device-2": {
          "status": "scan_qr",
          "qr": "data:image/png;base64,..."
      }
  }
  ```

#### Get Session Status
- **Endpoint**: `GET /api/sessions/:sessionId`

#### Delete/Logout Session
Logs out and removes session data from the database.

- **Delete All Sessions**:
    - **Endpoint**: `DELETE /api/sessions`
    - **Response**: `{"message": "All sessions deleted", "count": 2}`

- **Delete Specific Session**:
    - **Endpoint**: `DELETE /api/sessions/:sessionId`

#### Restart Session
Restart a session. Useful if the QR code generation has timed out/stopped.
- **Endpoint**: `POST /api/sessions/:sessionId/restart`
- **Response**:
  ```json
  {
      "message": "Session restarted",
      "sessionId": "my-device-1"
  }
  ```

#### Set Session Webhook
Dynamically update the webhook URL for a specific session.
- **Endpoint**: `PUT /api/sessions/:sessionId/webhook`
- **Body**:
  ```json
  {
      "url": "https://new-webhook-url.com"
  }
  ```

### Sending Messages

#### Send Text/Media
- **Endpoint**: `POST /api/sessions/:sessionId/send-message`
- **Body (Text)**:
  ```json
  {
      "jid": "628123456789@s.whatsapp.net",
      "message": {
          "text": "Hello World"
      }
  }
  ```
- **Body (Image)**:
  ```json
  {
      "jid": "628123456789@s.whatsapp.net",
      "message": {
          "image": { "url": "https://example.com/image.png" },
          "caption": "Check this out!"
      }
  }
  ```
- **Response**:
  ```json
  {
      "status": "success",
      "messageId": "3EB0ABC123DEF456",
      "response": { ... }
  }
  ```
  > **Note**: Save the `messageId` to track delivery status!

---

### Mark as Read (Send Seen)

Send read receipts to let senders know their messages have been seen (blue checkmarks ✓✓).

#### Mark Messages as Read
- **Endpoint**: `POST /api/sessions/:sessionId/read`
- **Body**:
  ```json
  {
      "messages": [
          {
              "remoteJid": "628123456789@s.whatsapp.net",
              "id": "3EB0ABC123DEF456"
          }
      ]
  }
  ```
  
  For group messages, include the sender's participant ID:
  ```json
  {
      "messages": [
          {
              "remoteJid": "120363123456789@g.us",
              "id": "3EB0ABC123DEF456",
              "participant": "628123456789@s.whatsapp.net"
          }
      ]
  }
  ```
- **Response**:
  ```json
  {
      "success": true,
      "count": 1
  }
  ```

> **Tip**: When you receive a message via webhook, use the `data.key` object to mark it as read:
> - `remoteJid` = `data.key.remoteJid`
> - `id` = `data.key.id`
> - `participant` = `data.key.participant` (for groups)

---

### Presence / Typing Indicator

Show typing indicators or recording status to contacts.

#### Send Presence Update
- **Endpoint**: `POST /api/sessions/:sessionId/presence`
- **Body**:
  ```json
  {
      "jid": "628123456789@s.whatsapp.net",
      "presence": "composing"
  }
  ```
- **Valid Presence Values**:
  | Value | Description |
  |-------|-------------|
  | `composing` | Show "typing..." indicator |
  | `paused` | Stop typing indicator |
  | `recording` | Show "recording audio..." indicator |
  | `available` | Set status to online |
  | `unavailable` | Set status to offline |

- **Response**:
  ```json
  {
      "success": true,
      "presence": "composing",
      "jid": "628123456789@s.whatsapp.net"
  }
  ```

> **Example Workflow**: Before sending a reply, show typing for 1-2 seconds for a natural feel:
> 1. Send "composing" presence
> 2. Wait 1-2 seconds
> 3. Send the message
> 4. Send "paused" presence

---

### Download Media

Download images, videos, audio, documents, and stickers from received messages.

#### Download Media from Message
- **Endpoint**: `POST /api/sessions/:sessionId/download-media`
- **Body**: Pass the full message `data` object from the webhook
  ```json
  {
      "message": {
          "key": {
              "remoteJid": "628123456789@s.whatsapp.net",
              "id": "3EB0ABC123DEF456",
              "fromMe": false
          },
          "message": {
              "imageMessage": {
                  "url": "https://mmg.whatsapp.net/...",
                  "mimetype": "image/jpeg",
                  "caption": "Check this out!",
                  "fileSha256": "...",
                  "fileLength": 123456,
                  "jpegThumbnail": "..."
              }
          }
      }
  }
  ```
- **Response**:
  ```json
  {
      "success": true,
      "mediaType": "image",
      "mimetype": "image/jpeg",
      "filename": "media_1736789012345",
      "filesize": 123456,
      "caption": "Check this out!",
      "base64": "/9j/4AAQSkZJRg...",
      "dataUrl": "data:image/jpeg;base64,/9j/4AAQSkZJRg..."
  }
  ```

#### Supported Media Types
| Type | Message Key |
|------|-------------|
| Image | `imageMessage` |
| Video | `videoMessage` |
| Audio | `audioMessage` |
| Document | `documentMessage` |
| Sticker | `stickerMessage` |

#### Example: Handling Image in Webhook
```javascript
app.post('/webhook', async (req, res) => {
    const { event, sessionId, data } = req.body;
    
    if (event === 'messages.upsert') {
        // Check if message contains media
        if (data.message?.imageMessage) {
            // Download the image
            const mediaRes = await fetch(`http://localhost:8181/api/sessions/${sessionId}/download-media`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: data })
            });
            const media = await mediaRes.json();
            
            if (media.success) {
                // media.base64 contains the image data
                // media.dataUrl can be used directly in <img src="">
                console.log(`Received image: ${media.mimetype}, ${media.filesize} bytes`);
            }
        }
    }
    
    res.sendStatus(200);
});
```

> **Note**: Media download requires the session to be connected. The base64 data can be large for videos/documents.

---

### Message Status Tracking

Track whether your sent messages are delivered, read, or played.

#### Status Codes Reference
| Code | Status | Icon | Description |
|------|--------|------|-------------|
| 1 | `pending` | 🕐 | Message is being sent |
| 2 | `server_ack` | ✓ (gray) | Server received the message |
| 3 | `delivered` | ✓✓ (gray) | Delivered to recipient's device |
| 4 | `read` | ✓✓ (blue) | Read/seen by recipient |
| 5 | `played` | ✓✓ (blue) | Voice/video message was played |

#### Get Message Status
Check the current status of a specific message.
- **Endpoint**: `GET /api/sessions/:sessionId/messages/:messageId/status`
- **Example**: `GET /api/sessions/my-device-1/messages/3EB0ABC123/status`
- **Response**:
  ```json
  {
      "messageId": "3EB0ABC123",
      "remoteJid": "628123456789@s.whatsapp.net",
      "fromMe": true,
      "statusCode": 3,
      "status": "read",
      "sentAt": 1736716019000,
      "updatedAt": 1736716025000,
      "history": [
          { "statusCode": 1, "status": "server_ack", "timestamp": 1736716019000 },
          { "statusCode": 2, "status": "delivered", "timestamp": 1736716021000 },
          { "statusCode": 3, "status": "read", "timestamp": 1736716025000 }
      ]
  }
  ```

#### Get All Tracked Messages
List all recently sent messages and their statuses.
- **Endpoint**: `GET /api/sessions/:sessionId/messages?limit=50`
- **Query Parameters**:
  - `limit` (optional): Number of messages to return (default: 50)
- **Response**:
  ```json
  {
      "sessionId": "my-device-1",
      "count": 2,
      "messages": [
          {
              "messageId": "3EB0ABC123",
              "remoteJid": "628123456789@s.whatsapp.net",
              "fromMe": true,
              "statusCode": 3,
              "status": "read",
              "sentAt": 1736716019000,
              "updatedAt": 1736716025000
          },
          {
              "messageId": "3EB0DEF456",
              "remoteJid": "628987654321@s.whatsapp.net",
              "fromMe": true,
              "statusCode": 2,
              "status": "delivered",
              "sentAt": 1736716010000,
              "updatedAt": 1736716015000
          }
      ]
  }
  ```

#### Get Status Codes Reference
- **Endpoint**: `GET /api/message-status-codes`
- **Response**:
  ```json
  {
      "codes": {
          "0": "pending",
          "1": "server_ack",
          "2": "delivered",
          "3": "read",
          "4": "played"
      },
      "description": {
          "pending": "Message is being sent",
          "server_ack": "Server received the message",
          "delivered": "Message delivered to recipient device (single checkmark)",
          "read": "Message read/seen by recipient (blue double checkmarks)",
          "played": "Voice/video message was played"
      }
  }
  ```

> **Note**: Message statuses are stored in memory and automatically cleaned up after 24 hours.

---

### Profile Pictures

Fetch profile pictures for any WhatsApp contact.

#### Get Profile Picture
- **Endpoint**: `GET /api/sessions/:sessionId/profile-picture/:jid`
- **Example**: `GET /api/sessions/my-device-1/profile-picture/628123456789@s.whatsapp.net`
- **Response**:
  ```json
  {
      "jid": "628123456789@s.whatsapp.net",
      "profilePicUrl": "https://pps.whatsapp.net/v/t61.24694-24/...",
      "note": null
  }
  ```
  
  If profile picture is not available:
  ```json
  {
      "jid": "628123456789@s.whatsapp.net",
      "profilePicUrl": null,
      "note": "Profile picture not available (privacy settings or no picture set)"
  }
  ```

> **Note**: Profile pictures are cached for 1 hour to reduce API calls.

---

### Contacts

Access saved contact names from your WhatsApp device.

#### Get All Contacts
- **Endpoint**: `GET /api/sessions/:sessionId/contacts`
- **Response**:
  ```json
  {
      "sessionId": "my-device-1",
      "count": 150,
      "contacts": [
          {
              "jid": "628123456789@s.whatsapp.net",
              "name": "John Doe",
              "notify": "Johnny",
              "verifiedName": null,
              "imgUrl": null,
              "status": "Hey there!"
          }
      ]
  }
  ```

#### Get Specific Contact
- **Endpoint**: `GET /api/sessions/:sessionId/contacts/:jid`
- **Example**: `GET /api/sessions/my-device-1/contacts/628123456789@s.whatsapp.net`
- **Response**:
  ```json
  {
      "jid": "628123456789@s.whatsapp.net",
      "name": "John Doe",
      "notify": "Johnny",
      "verifiedName": null,
      "profilePicUrl": "https://pps.whatsapp.net/v/t61.24694-24/..."
  }
  ```

> **Note**: Contact names are the names **you** saved for contacts on your device. `notify` is the user's self-set profile name (push name).

---

## 3. Webhook Integration

Configure the `WEBHOOK_URL` in your `.env` file to receive real-time updates.

### Event Format
All webhooks are sent as `POST` requests with a JSON body.

### Available Webhook Events

#### 1. Incoming Message (`messages.upsert`)
Triggered when a new message is received. Includes sender info with contact name.

**Payload**:
```json
{
  "event": "messages.upsert",
  "sessionId": "my-device-1",
  "data": {
    "key": {
      "remoteJid": "628123456789@s.whatsapp.net",
      "fromMe": false,
      "id": "3EB0..."
    },
    "message": {
      "conversation": "Hello there!"
    },
    "messageTimestamp": 1678888888,
    "pushName": "John Doe"
  },
  "senderInfo": {
    "jid": "628123456789@s.whatsapp.net",
    "pushName": "John Doe",
    "contactName": "Johnny Work"
  }
}
```

**Sender Info Fields**:
| Field | Description |
|-------|-------------|
| `jid` | WhatsApp ID of the sender |
| `pushName` | Name the sender set for themselves |
| `contactName` | Name **you** saved for this contact (null if not saved) |

> **Profile Pictures**: To get sender's profile picture, use the API endpoint:
> `GET /api/sessions/:sessionId/profile-picture/:jid`
> This is on-demand to avoid unnecessary API calls on every message.

#### 2. Message Status Update (`messages.update`)
Triggered when the status of a sent message changes (delivered, read, played).

**Payload**:
```json
{
  "event": "messages.update",
  "sessionId": "my-device-1",
  "data": {
    "messageId": "3EB0ABC123DEF456",
    "remoteJid": "628123456789@s.whatsapp.net",
    "fromMe": true,
    "statusCode": 3,
    "status": "read",
    "timestamp": 1736716025000
  }
}
```

**Status Values**:
- `pending` (0) - Message sending
- `server_ack` (1) - Server received
- `delivered` (2) - Delivered to device ✓
- `read` (3) - Read/seen ✓✓
- `played` (4) - Voice/video played

### Handling Webhooks (Example in Express.js)
```javascript
app.post('/webhook', (req, res) => {
    const { event, sessionId, data } = req.body;
    
    if (event === 'messages.upsert') {
        // Handle incoming message
        const sender = data.key.remoteJid;
        const text = data.message?.conversation || data.message?.extendedTextMessage?.text;
        
        console.log(`Received message from ${sender} on session ${sessionId}: ${text}`);
    }
    
    if (event === 'messages.update') {
        // Handle message status update
        const { messageId, status, statusCode } = data;
        
        console.log(`Message ${messageId} status changed to: ${status} (${statusCode})`);
        
        // Example: Update your database
        if (status === 'delivered') {
            // Message was delivered
        } else if (status === 'read') {
            // Message was read/seen
        }
    }
    
    res.sendStatus(200);
});
```

---

## 4. Usage Workflow Example

### Complete Send & Track Flow

1. **Send a message**:
   ```bash
   curl -X POST http://localhost:3000/api/sessions/my-device/send-message \
     -H "Content-Type: application/json" \
     -d '{"jid": "628123456789@s.whatsapp.net", "message": {"text": "Hello!"}}'
   ```
   
   Response:
   ```json
   {"status": "success", "messageId": "3EB0ABC123", "response": {...}}
   ```

2. **Check status via API** (polling):
   ```bash
   curl http://localhost:3000/api/sessions/my-device/messages/3EB0ABC123/status
   ```

3. **Or receive status via webhook** (recommended):
   Your webhook will receive `messages.update` events as the status changes.

---

## 5. Database Schema

The service automatically creates the necessary table in your MySQL database.

**Table**: `session_store`
- `id` (VARCHAR): `sessionId:key`
- `data` (LONGTEXT): JSON serialized session data

