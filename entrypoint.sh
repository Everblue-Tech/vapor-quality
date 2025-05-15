#!/bin/sh

echo "Substituting env vars into nginx.conf"
echo "REACT_APP_VAPORFLOW_NO_PROTOCOL = ${REACT_APP_VAPORFLOW_NO_PROTOCOL}"
echo "REACT_APP_VAPORFLOW_URL = ${REACT_APP_VAPORFLOW_URL}"

envsubst '${REACT_APP_VAPORFLOW_NO_PROTOCOL} ${REACT_APP_VAPORFLOW_URL}' \
  < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf

cat /etc/nginx/nginx.conf

exec nginx -g 'daemon off;'
