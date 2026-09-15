# Abstract ABA web client — static build served by nginx. The nginx config adds
# security headers and a no-store policy (responses can carry PHI and must never
# sit in a shared cache). Built from the repository root for the shared package.
FROM node:20-slim AS build
WORKDIR /repo
COPY package.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN npm install --include-workspace-root --workspace apps/web --no-audit --no-fund
RUN npm run build --workspace apps/web

FROM nginx:1.27-alpine AS runtime
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
