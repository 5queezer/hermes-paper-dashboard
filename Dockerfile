FROM node:20-alpine
RUN apk add --no-cache nginx && mkdir -p /run/nginx /app/public/data
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY scripts/ ./scripts/
COPY public/ ./public/
COPY docker-entrypoint.sh /usr/local/bin/hermes-dashboard-entrypoint
RUN chmod +x /usr/local/bin/hermes-dashboard-entrypoint \
  && printf 'server { listen 80; server_name _; root /app/public; index index.html; location / { try_files $uri $uri/ /index.html; } location /data/ { add_header Cache-Control "no-store"; try_files $uri =404; } }\n' > /etc/nginx/http.d/default.conf
EXPOSE 80
ENTRYPOINT ["/usr/local/bin/hermes-dashboard-entrypoint"]
