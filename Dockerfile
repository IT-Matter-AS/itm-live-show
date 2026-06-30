# Lightweight container for any host that terminates TLS at its edge
# (Fly, Render, Railway, Cloud Run, …). The platform gives you the public HTTPS
# URL; set PUBLIC_URL to it so the QR points there (no cert warning, works on
# cellular). HTTP_ONLY=1 means the app serves plain HTTP behind that TLS proxy.
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=3000 HTTP_ONLY=1
EXPOSE 3000
CMD ["node", "server/server.js"]
