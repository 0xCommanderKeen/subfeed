FROM node:26-slim
WORKDIR /app
ENV HOST=0.0.0.0 PORT=4173
COPY package.json ./
COPY src ./src
COPY bin ./bin
COPY public ./public
RUN mkdir -p data && chown node:node data
USER node
VOLUME /app/data
EXPOSE 4173
CMD ["node", "src/server.mjs"]
