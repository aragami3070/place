FROM node:22
LABEL maintainer="applebetas@dynastic.co"

# Зависимости из git (dynastic-provider, mongoose-datatables) тянутся по https
RUN git config --global url."https://github.com/".insteadOf ssh://git@github.com/

WORKDIR /usr/src/app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY . .

# Если config/config.js не передан, берём пример: все настройки читаются из env (см. .env.example)
RUN [ -f config/config.js ] || cp config/config.example.js config/config.js

EXPOSE 3000
CMD [ "node", "app.js" ]
