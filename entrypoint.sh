#!/bin/sh
envsubst '${REACT_APP_VAPORFLOW_URL}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf
exec nginx -g 'daemon off;'
