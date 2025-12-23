#!/bin/bash

echo "🚀 Starting WhatsApp Scheduler..."
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 18 or higher."
    exit 1
fi

# Check if we're in the right directory
if [ ! -d "backend" ]; then
    echo "❌ backend directory not found. Please run this script from the project root."
    exit 1
fi

# Install dependencies if needed
if [ ! -d "backend/node_modules" ]; then
    echo "📦 Installing dependencies..."
    cd backend && npm install && cd ..
fi

# Create .env if it doesn't exist
if [ ! -f "backend/.env" ]; then
    echo "📝 Creating .env file..."
    cp backend/.env.example backend/.env
fi

# Start the server
echo "🌐 Starting server on http://localhost:3000"
echo "📱 Open this URL in your browser to scan the QR code"
echo ""
echo "Press Ctrl+C to stop the server"
echo ""

cd backend && npm start
