# WhatsApp Scheduler Bot

A self-hosted WhatsApp bot that allows you to schedule messages for later delivery. Built with whatsapp-web.js and Node.js.

## Features

- 📱 Connect your WhatsApp account via QR code
- ⏰ Schedule messages using natural language (e.g., "tomorrow at 9", "in 2 hours")
- 🔄 Forward messages to easily select recipients
- 🌍 Israel timezone support with automatic DST handling
- 📊 Web dashboard to view scheduled messages
- ✅ Automatic message delivery at scheduled times
- ❌ Error notifications sent directly to WhatsApp

## How It Works

1. **Forward a message** from someone to yourself (or your bot chat)
2. **Send a command**: `/reply <time> <message>`
   - Example: `/reply tomorrow at 9 Good morning!`
   - Example: `/reply in 2 hours Don't forget the meeting`
   - Example: `/reply next Monday at 14:00 Weekly reminder`
3. **The bot schedules it** and confirms with a message
4. **At the scheduled time**, the message is automatically sent

## Installation

### Prerequisites

- Node.js 18 or higher
- npm or yarn
- A WhatsApp account

### Local Development

1. Clone the repository:
```bash
git clone <your-repo-url>
cd whatsapp_listen_to_me
```

2. Install backend dependencies:
```bash
cd backend
npm install
```

3. Create a `.env` file in the backend directory:
```bash
cp .env.example .env
```

4. Start the server:
```bash
npm start
```

5. Open your browser to `http://localhost:3000`

6. Scan the QR code with WhatsApp (WhatsApp > Settings > Linked Devices > Link a Device)

## Deployment to Railway

### Quick Deploy

1. Push your code to GitHub

2. Go to [Railway.app](https://railway.app) and sign in

3. Click "New Project" → "Deploy from GitHub repo"

4. Select your repository

5. Railway will automatically detect the Dockerfile and build your app

6. Once deployed, click on your service and copy the public URL

7. Open the URL in your browser and scan the QR code with WhatsApp

### Environment Variables

No environment variables are strictly required, but you can optionally set:

- `PORT` - Server port (default: 3000)
- `NODE_ENV` - Environment (production/development)

### Important Notes for Railway

- WhatsApp session data is stored locally in `whatsapp-session/`
- The database is stored in `scheduled.db`
- Both will persist as long as your Railway volume persists
- If you redeploy or restart, you may need to scan the QR code again

## Project Structure

```
whatsapp_listen_to_me/
├── backend/
│   ├── server.js           # Express server & API endpoints
│   ├── whatsappClient.js   # WhatsApp client initialization
│   ├── messageHandler.js   # /reply command handler
│   ├── timeParser.js       # Natural language time parsing
│   ├── scheduler.js        # Cron job for sending messages
│   ├── database.js         # SQLite database functions
│   └── package.json
├── frontend/
│   ├── index.html          # Main UI
│   ├── styles.css          # Styling
│   └── app.js              # Frontend JavaScript
├── Dockerfile              # Docker configuration
└── README.md
```

## API Endpoints

- `GET /health` - Health check
- `GET /api/qr` - Get QR code for WhatsApp connection
- `GET /api/status` - Get connection status
- `GET /api/messages` - Get all scheduled messages
- `GET /api/stats` - Get statistics (total, pending, sent, failed)

## Database Schema

```sql
CREATE TABLE scheduled_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient TEXT NOT NULL,
  recipient_name TEXT,
  message TEXT NOT NULL,
  scheduled_time DATETIME NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  error_message TEXT
);
```

## Natural Language Time Examples

The bot understands various time formats:

- `tomorrow at 9` → Next day at 9:00 AM
- `tomorrow at 14:30` → Next day at 2:30 PM
- `in 2 hours` → 2 hours from now
- `in 30 minutes` → 30 minutes from now
- `next Monday at 10` → Following Monday at 10:00 AM
- `Dec 25 at 12:00` → December 25th at noon

All times are interpreted in **Israel timezone (UTC+2/+3 with DST)**.

## Troubleshooting

### WhatsApp disconnects frequently

- Make sure you're using WhatsApp Web multi-device mode
- Don't log out from WhatsApp on your phone
- Keep your phone connected to the internet

### QR code doesn't appear

- Check the browser console for errors
- Refresh the page
- Check if the backend is running (`/health` endpoint)

### Messages not sending

- Check the dashboard for error messages
- Verify the WhatsApp connection status
- Check backend logs for errors

### Railway deployment issues

- Make sure the Dockerfile is in the root directory
- Check Railway logs for build/runtime errors
- Ensure sufficient resources are allocated

## Security Notes

- This bot connects to WhatsApp using an unofficial library (whatsapp-web.js)
- WhatsApp may ban accounts using unofficial clients
- Use at your own risk
- Do not use with important/business WhatsApp accounts
- All data is stored locally on your server
- Keep your deployment URL private

## License

MIT

## Contributing

Pull requests are welcome! Please open an issue first to discuss proposed changes.

## Support

For issues and questions, please open a GitHub issue.
