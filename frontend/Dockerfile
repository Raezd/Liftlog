# Stage 1: build the app.
FROM node:22.23.3-alpine3.24 AS build
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY app/ ./
# Short git hash shown on the page; Compose passes it in (see CLAUDE.md).
ARG BUILD_ID=
ENV BUILD_ID=$BUILD_ID
RUN npm run build

# Stage 2: serve the built files with Caddy. Node isn't in the final image.
FROM caddy:2.10.2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
