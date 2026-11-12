FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY docker/healthcheck.js ./healthcheck.js
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 6380
HEALTHCHECK --interval=5s --timeout=3s --retries=5 CMD ["node", "healthcheck.js"]
ENTRYPOINT ["node", "dist/index.js", "--bind", "0.0.0.0", "--dir", "/data"]
