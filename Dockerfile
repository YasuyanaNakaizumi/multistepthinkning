# Multi-stage build for Azure Container App
FROM node:20-alpine AS builder

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY

# Set working directory
WORKDIR /app

# Copy root package.json and lock files
COPY package*.json ./

# Copy workspace manifests so npm can detect workspaces during install
COPY backend/package*.json ./backend/
COPY frontend/package*.json ./frontend/

# Install root dependencies
RUN npm config set fetch-retries 5 \
  && npm config set fetch-retry-mintimeout 20000 \
  && npm config set fetch-retry-maxtimeout 300000 \
  && npm ci --no-audit --prefer-offline

# Copy backend and frontend
COPY backend ./backend
COPY frontend ./frontend

# Copy data files used at runtime
COPY documents.json ./documents.json
COPY md_out_toc ./md_out_toc

# Build backend
WORKDIR /app/backend
RUN npm run build

# Build frontend
WORKDIR /app/frontend
RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Copy backend dependencies and built files
COPY --from=builder /app/backend/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/backend/dist ./dist

# Copy data files (documents catalog and TOC markdown)
COPY --from=builder /app/documents.json ./documents.json
COPY --from=builder /app/md_out_toc ./md_out_toc

# Copy frontend build output to be served by backend
COPY --from=builder /app/frontend/dist ./public

# Set environment to production
ENV NODE_ENV=production

# Expose port
EXPOSE 3001

# Start the backend server (which will also serve the frontend)
CMD ["node", "dist/index.js"]
