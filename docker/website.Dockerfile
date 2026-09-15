# Abstract ABA public website — static build served by nginx. A separate
# application from the tenant web panel and the platform console; it shares only
# the brand package. Built from the repository root for the shared package.
# Build-time public settings: VITE_API_BASE_URL (existing API) and
# VITE_WEB_APP_URL (existing web panel, for "Sign In").
FROM node:20-slim AS build
WORKDIR /repo
ARG VITE_API_BASE_URL=/api
ARG VITE_WEB_APP_URL=http://localhost:3000
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL VITE_WEB_APP_URL=$VITE_WEB_APP_URL
COPY package.json ./
COPY packages ./packages
COPY apps/website ./apps/website
RUN npm install --include-workspace-root --workspace apps/website --no-audit --no-fund
RUN npm run build --workspace apps/website

FROM nginx:1.27-alpine AS runtime
COPY docker/website-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/website/dist /usr/share/nginx/html
EXPOSE 80
