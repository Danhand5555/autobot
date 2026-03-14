#!/bin/bash
# Start Chrome with remote debugging so the bot can connect to it.
# This reuses YOUR Chrome profile — you're already logged in!

PORT=9222
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

echo "🔌 Starting Chrome with remote debugging on port $PORT..."
echo "   Your bot can now connect to this browser."
echo ""

"$CHROME" --remote-debugging-port=$PORT &
