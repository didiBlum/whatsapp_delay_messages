# Quick Start Guide

## Local Testing

1. **Start the server**:
```bash
cd backend
npm start
```

2. **Open your browser** to `http://localhost:3000`

3. **Scan the QR code** with WhatsApp:
   - Open WhatsApp on your phone
   - Go to Settings → Linked Devices
   - Tap "Link a Device"
   - Scan the QR code shown in your browser

4. **Test the bot**:
   - In WhatsApp, send a message to yourself (or create a group with just you)
   - Forward any message to that chat
   - Then send: `/reply in 2 minutes Test message`
   - You should get a confirmation message
   - After 2 minutes, the message will be sent

## Deploy to Railway

### Method 1: GitHub (Recommended)

1. **Initialize git** (if not already):
```bash
git init
git add .
git commit -m "Initial commit"
```

2. **Push to GitHub**:
```bash
# Create a new repository on GitHub first
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git branch -M main
git push -u origin main
```

3. **Deploy on Railway**:
   - Go to [railway.app](https://railway.app)
   - Click "New Project"
   - Select "Deploy from GitHub repo"
   - Choose your repository
   - Railway will automatically detect the Dockerfile and deploy
   - Wait for deployment to complete

4. **Access your app**:
   - Click on your service in Railway
   - Click "Settings" → "Generate Domain"
   - Copy the public URL
   - Open it in your browser and scan the QR code

### Method 2: Railway CLI

1. **Install Railway CLI**:
```bash
npm install -g @railway/cli
```

2. **Login and deploy**:
```bash
railway login
railway init
railway up
```

3. **Get your URL**:
```bash
railway domain
```

## Important Notes

- **First-time setup**: After deployment, you need to scan the QR code once
- **Session persistence**: Your WhatsApp session will persist across restarts
- **Re-scanning**: If the session expires (~20 days), you'll need to scan the QR code again
- **Timezone**: All times are in Israel timezone (UTC+2/+3 with DST)

## Command Examples

Once connected, send these commands to yourself in WhatsApp:

1. **Forward a message** from the person you want to schedule a reply to

2. **Send your scheduled message**:
   - `/reply tomorrow at 9 Good morning!`
   - `/reply in 30 minutes Don't forget!`
   - `/reply next Monday at 14:00 Weekly reminder`
   - `/reply Dec 25 at 12:00 Merry Christmas!`

3. **Check the dashboard** to see all scheduled messages

## Troubleshooting

**Server won't start?**
- Make sure you're in the `backend` directory
- Run `npm install` to ensure dependencies are installed

**QR code not showing?**
- Wait a few seconds for the WhatsApp client to initialize
- Refresh the page

**Not receiving confirmations?**
- Make sure you're sending commands to yourself (your own chat)
- Check that the message starts with `/reply` (case insensitive)

**Messages not sending?**
- Check the dashboard for errors
- Make sure the scheduled time is in the future
- Verify WhatsApp is still connected (check the status indicator)

## Support

If you encounter issues:
1. Check the browser console for errors (F12)
2. Check the server logs in your terminal
3. For Railway deployments, check the deployment logs in the Railway dashboard

Enjoy your WhatsApp scheduler! 🎉
