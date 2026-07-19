# Production Deployment Guide

## Prerequisites
- Docker Engine >= 20.10
- Docker Compose >= 2.0
- A domain name pointing to the host (e.g., `backend.example.com`).

## Steps
1. Clone the repository and checkout the desired branch.
2. Build and start the stack using the production compose file:
   ```
   docker compose -f docs/deploy/compose.prod.yaml up -d --build
   ```
3. Caddy will automatically obtain HTTPS certificates via Let’s Encrypt (or use the internal self‑signed CA for local testing).
4. Verify HTTP/2 is active:
   ```
   curl -sv --http2 https://backend.example.com/health
   ```
5. To perform a zero‑downtime deploy, push a new image and run:
   ```
   docker compose -f docs/deploy/compose.prod.yaml pull backend
   docker compose -f docs/deploy/compose.prod.yaml up -d backend
   ```
   Caddy will gracefully reload connections.
