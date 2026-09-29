FROM node:20-alpine

WORKDIR /app

# Copy the whole repository
COPY . .

# Install dependencies in signaling folder
RUN cd signaling && npm install

EXPOSE 3000

# Start server
CMD ["node", "signaling/server.js"]
