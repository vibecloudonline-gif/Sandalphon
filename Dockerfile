# Render / any Docker host. Playwright's image ships Chromium + system deps matching playwright@1.56.1.
FROM mcr.microsoft.com/playwright:v1.56.1-noble AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.56.1-noble
ENV NODE_ENV=production \
    PORT=10000 \
    CRAWLEE_LOG_LEVEL=INFO
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
# The image's non-root user.
USER pwuser
EXPOSE 10000
CMD ["node", "dist/server.js"]
