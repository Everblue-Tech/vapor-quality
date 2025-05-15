#!/bin/sh

# Substitute env var into template
envsubst '${REACT_APP_VAPORFLOW_URL}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf

# Show generated file for debugging
echo "---- Generated nginx.conf ----"
cat /etc/nginx/nginx.conf
echo "------------------------------"

# Test NGINX config before starting
nginx -t
if [ $? -ne 0 ]; then
  echo "NGINX config test failed"
  exit 1
fi

# Start NGINX
exec nginx -g 'daemon off;'
