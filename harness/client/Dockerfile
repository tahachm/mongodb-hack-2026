# Build context is harness/ (npm workspace root, shared package-lock.json).
# Runs the Vite dev server rather than a static build: VITE_HARNESS_SERVER_URL is baked in
# at build time by Vite, so a prod build couldn't be retargeted per-environment without a
# rebuild. The dev server reads it from the environment at container start instead.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
RUN npm ci
COPY client ./client
WORKDIR /app/client
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]
