ARG NODE_VERSION=24.22.1
FROM node:${NODE_VERSION}-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

USER node
EXPOSE 3001
CMD ["node", "src/main.ts"]
