FROM denoland/deno:debian

RUN mkdir /app
WORKDIR /app

COPY ./deno.jsonc ./deno.jsonc
COPY ./deno.lock ./deno.lock
COPY ./vendor ./vendor
COPY ./main.ts ./main.ts

CMD ["deno", "serve", "--allow-env", "--unstable-kv", "--unstable-cron", "--allow-net=0.0.0.0:8000,dkv.fly.dev,api.telegram.org:443", "main.ts"]
