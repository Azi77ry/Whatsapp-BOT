FROM node:20-bullseye-slim

# Install system dependencies (ffmpeg, git, python, build-essential)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    imagemagick \
    webp \
    git \
    python3 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency definitions
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy application files
COPY . .

# Expose web dashboard port
EXPOSE 3000

# Start server
CMD ["node", "server.js"]
