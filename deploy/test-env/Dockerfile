# TEST ENVIRONMENT ONLY (DR-173/5). One image; the process is chosen by PROCESS_MODE
# in the env file of each compose service. No secret is baked in: the image carries code only.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY infrastructure ./infrastructure
COPY tsconfig*.json ./
RUN npm ci
RUN npm run build -w @daftar/api

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=development
COPY --from=build /app /app
USER node
CMD ["npm", "run", "start", "-w", "@daftar/api"]
