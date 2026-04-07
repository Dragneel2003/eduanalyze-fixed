FROM node:18

# Install poppler + graphics tools
RUN apt-get update && apt-get install -y \
    poppler-utils \
    graphicsmagick \
    imagemagick

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

CMD ["node", "server.js"]
