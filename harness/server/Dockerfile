# Build context is harness/ (npm workspace root, shared package-lock.json).
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
RUN npm ci
COPY server ./server
RUN npm run build --workspace=server
ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "server/dist/index.js"]
