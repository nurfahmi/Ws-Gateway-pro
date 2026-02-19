# WA Gateway Pro

WhatsApp Multi-Device Gateway with dashboard, session management, and REST API.

## Requirements

- Node.js 18+
- MySQL 5.7+ / 8.0+

## Installation

```bash
git clone https://github.com/nurfahmi/Ws-Gateway-pro.git
cd Ws-Gateway-pro
npm install
```

Copy the environment file and edit it:

```bash
cp .env.example .env
```

Edit `.env` with your database credentials:

```
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=yourpassword
DB_NAME=whatsapp_baileys
DB_PORT=3306
PORT=3002
WEBHOOK_URL=http://localhost:3000/webhook
SESSION_SECRET=change-me-to-a-random-string
DATABASE_URL="mysql://root:yourpassword@localhost:3306/whatsapp_baileys"
```

Generate Prisma client:

```bash
npx prisma generate
```

## First Run

```bash
npm start
```

On first run the app will:
1. **Auto-create** the MySQL database if it doesn't exist
2. **Auto-sync** all tables via Prisma
3. Print a **one-time setup URL** in the terminal to create your superadmin account

```
═══════════════════════════════════════════════════
  🔐 FIRST-TIME SETUP
  No admin account found. Use this one-time link
  to create your superadmin account:

  http://localhost:3002/setup/<token>

  ⚠️  This link expires after use or on restart.
═══════════════════════════════════════════════════
```

Open the link in your browser, fill in your admin credentials, and you're ready to go.

## Development

```bash
npm run dev
```

## Cloudflare Tunnel (HTTPS)

The app supports running behind Cloudflare Tunnel out of the box. Just point the tunnel to your local port:

```bash
cloudflared tunnel --url http://localhost:3002
```

The app has `trust proxy` enabled and secure cookies set to `auto`, so sessions work correctly over HTTPS.

## API

Full API documentation is available at `/docs` after login.
