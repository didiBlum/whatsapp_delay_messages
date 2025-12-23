# Railway Deployment Guide

## Quick Setup (5 minutes)

### 1. Deploy to Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new)

Or manually:
```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Initialize project
railway init

# Deploy
railway up
```

### 2. Add Persistent Volume (CRITICAL!)

**⚠️ Without a volume, your database and WhatsApp session will be deleted on every deployment!**

1. Go to your Railway project dashboard
2. Click on your service
3. Go to **"Settings"** tab
4. Scroll to **"Volumes"** section
5. Click **"Add Volume"**
6. Configure:
   - **Mount Path:** `/data`
   - Click **"Add"**

### 3. Set Environment Variables

Go to **"Variables"** tab and add:

**Required:**
```bash
DATABASE_PATH=/data/scheduled.db
SESSION_PATH=/data/whatsapp-session
```

**Optional:**
```bash
PORT=3000
NODE_ENV=production
DEDICATED_GROUP_ID=   # (optional) for group-only mode
```

### 4. First-Time WhatsApp Authentication

After deployment:

1. Go to **"Deployments"** tab
2. Click on the latest deployment
3. Click **"View Logs"**
4. Look for the QR code in the logs (it will be ASCII art)
5. Open WhatsApp on your phone
6. Go to: **Settings → Linked Devices → Link a Device**
7. Scan the QR code from the logs

**Note:** The QR code expires after 60 seconds. If it expires, Railway will automatically restart and show a new one.

### 5. Verify It's Working

1. Check logs for: `WhatsApp connected and ready!`
2. Check logs for: `Starting scheduler - checking every minute for pending messages`
3. Visit your Railway URL (e.g., `https://your-app.railway.app`)
4. You should see the frontend with "No scheduled messages yet"

---

## How It Works

### Database (SQLite)
- **File:** `/data/scheduled.db` (on Railway volume)
- **Auto-created** on first run
- **Persists** across deployments (thanks to volume)
- **Indexed** for efficient scheduler queries

### Scheduler (Node-Cron)
- **Runs inside your Node.js process** (no external cron needed!)
- **Frequency:** Every minute (`* * * * *`)
- **Query:** Checks for messages where `status='pending' AND scheduled_time <= NOW()`
- **Sends** messages via WhatsApp client
- **Updates** status to `sent` or `failed`

Railway keeps your server running 24/7, so the scheduler runs continuously.

### WhatsApp Session
- **File:** `/data/whatsapp-session/` (on Railway volume)
- **Persists** your authentication across deployments
- **No re-scanning** QR code after first setup (unless you clear session)

---

## Troubleshooting

### "No QR code appearing in logs"
- Check if session already exists: `ls /data/whatsapp-session/`
- If exists and not working, clear it: `rm -rf /data/whatsapp-session/`
- Restart deployment

### "Messages not sending"
Check logs for:
```bash
# Scheduler should run every minute
Scheduler tick: 2025-12-22T08:05:00.007Z

# If messages pending
Found 1 pending message(s) to send
Sending message 7 to +972501234567
✅ Message sent successfully
```

### "Database wiped after deployment"
You forgot to add the volume! See step 2.

### "WhatsApp keeps disconnecting"
- Ensure session volume is set up correctly
- Check if someone unlinked the device in WhatsApp settings
- Railway might be restarting too frequently (check deployment logs)

---

## Volume Configuration Summary

| What | Where | Why |
|------|-------|-----|
| **Volume Mount** | `/data` | Persistent storage across deployments |
| **Database** | `/data/scheduled.db` | Stores scheduled messages |
| **Session** | `/data/whatsapp-session/` | WhatsApp authentication |

**Environment Variables:**
```bash
DATABASE_PATH=/data/scheduled.db
SESSION_PATH=/data/whatsapp-session
```

---

## Monitoring

### View Logs
```bash
railway logs
```

### Check Scheduled Messages
Visit: `https://your-app.railway.app/api/scheduled`

### Frontend Dashboard
Visit: `https://your-app.railway.app`

---

## Cost Estimate (Railway)

- **Starter Plan:** $5/month includes 500 hours
- **Volume:** Free (included in Starter)
- **This app usage:** ~720 hours/month (runs 24/7)
- **Recommended:** Hobby Plan ($5/month) for continuous operation

---

## What Doesn't Require Setup

✅ **Scheduler** - Built into the Node.js app, runs automatically
✅ **Database** - Auto-initialized on first run
✅ **Cron Jobs** - No external cron service needed
✅ **Session Persistence** - Handled by volume

You just need to:
1. Add the volume
2. Set env vars
3. Scan QR code once
4. Done! 🚀
