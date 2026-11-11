FROM node:22.23.4-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .
RUN npm run build

EXPOSE 3000
CMD ["npm", "start"]
