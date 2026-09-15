# Abstract ABA platform console — static build served by nginx.
FROM node:20-slim AS build
WORKDIR /repo
COPY package.json ./
COPY packages ./packages
COPY apps/console ./apps/console
RUN npm install --include-workspace-root --workspace apps/console --no-audit --no-fund
RUN npm run build --workspace apps/console

FROM nginx:1.27-alpine AS runtime
COPY --from=build /repo/apps/console/dist /usr/share/nginx/html
EXPOSE 80
