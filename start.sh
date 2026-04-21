#!/bin/sh
set -e

# Fetch API key from Secrets Manager at boot (ECS only)
if [ -n "$REACT_APP_SECRET_ID" ]; then
  echo "Fetching API key from Secrets Manager..."
  export VAPOR_QUALITY_API_KEY=$(node -e "
    const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
    const client = new SecretsManagerClient({ region: process.env.REACT_APP_AWS_REGION });
    client.send(new GetSecretValueCommand({ SecretId: process.env.REACT_APP_SECRET_ID }))
      .then(r => { const s = JSON.parse(r.SecretString); process.stdout.write(s.VAPOR_QUALITY_API_KEY || ''); })
      .catch(e => { console.error('[ERROR] Failed to fetch API key:', e); process.exit(1); });
  ")
fi

# Render nginx config from template using env vars
envsubst '${VAPOR_FLOW_ORIGIN} ${SERVER_NAME} ${VAPOR_CORE_ORIGIN} ${VAPOR_QUALITY_API_KEY}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf

# Start Express
echo "Starting Express server..."
node /server/server.js 2>&1 | tee /dev/stdout | sed 's/^/[EXPRESS] /' &

# Wait a second to make sure it didn't crash
sleep 1

# Check if node is running
if ! pgrep -f "node /server/server.js" > /dev/null; then
  echo "[ERROR] Express server failed to start. Exiting..."
  exit 1
fi

# Start NGINX
echo "Starting NGINX..."
exec nginx -g 'daemon off;'
