FROM node:22-alpine

WORKDIR /app
COPY mobile-cloud ./mobile-cloud
COPY mobile-app ./mobile-app

ENV PORT=8787
ENV MOBILE_SYNC_DATA_DIR=/data
EXPOSE 8787
VOLUME ["/data"]

CMD ["node", "mobile-cloud/server.mjs"]
