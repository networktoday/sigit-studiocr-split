# Build stage
FROM node:20-slim AS build

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Runtime stage
FROM node:20-slim

WORKDIR /app

# Install Ghostscript, qpdf for PDF processing and htop for monitoring
RUN apt-get update && apt-get install -y \
    ghostscript \
    qpdf \
    htop \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/dist ./dist
COPY --from=build /app/package*.json ./

# Copy required PDF conversion files
COPY --from=build /app/server/PDFA_def.ps ./server/PDFA_def.ps
COPY --from=build /app/server/srgb.icc ./server/srgb.icc

# Install only production dependencies
RUN npm install --omit=dev

EXPOSE 5000

ENV NODE_ENV=production
ENV PORT=5000

CMD ["npm", "start"]
