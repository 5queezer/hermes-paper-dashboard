FROM node:20-alpine
RUN apk add --no-cache nginx apache2-utils && mkdir -p /run/nginx /app/public/data
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY scripts/ ./scripts/
COPY public/ ./public/
COPY docker-entrypoint.sh /usr/local/bin/hermes-dashboard-entrypoint
RUN chmod +x /usr/local/bin/hermes-dashboard-entrypoint
EXPOSE 80
ENTRYPOINT ["/usr/local/bin/hermes-dashboard-entrypoint"]
