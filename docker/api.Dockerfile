# Abstract ABA API — production image. Built from the repository root so the shared
# packages/ workspace is available to the npm install.
FROM node:20-slim
WORKDIR /repo
COPY package.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN npm install --omit=dev --include-workspace-root --workspace apps/api --no-audit --no-fund
ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "apps/api/src/server.js"]
