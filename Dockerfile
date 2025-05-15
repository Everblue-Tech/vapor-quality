# Stage 1: Build
FROM node:20-alpine AS builder

# Install dependencies required by node-gyp
RUN apk add --no-cache \
  python3 \
  py3-pip \
  make \
  g++ \
  libc-dev \
  cairo-dev \
  pango-dev \
  jpeg-dev \
  giflib-dev \
  pixman-dev \
  libpng-dev \
  pkgconfig

# Set working directory
WORKDIR /app

# Copy package.json and yarn.lock
COPY package.json yarn.lock ./

# Install dependencies
RUN yarn install --frozen-lockfile

# Copy source code
COPY . .

# Build the React app
RUN yarn run build

# Stage 2: Serve the build
FROM nginx:1.25-alpine

# Set working directory
WORKDIR /usr/share/nginx/html

# Remove default nginx static assets
RUN rm -rf ./*

# Copy build output from Stage 1
COPY --from=builder /app/build .

# Expose port 80
EXPOSE 80

# Copy custom Nginx config and entrypoint script
COPY nginx.conf /etc/nginx/nginx.conf
COPY entrypoint.sh /entrypoint.sh

# Make entrypoint executable
RUN chmod +x /entrypoint.sh

# Use custom entrypoint
ENTRYPOINT ["/entrypoint.sh"]