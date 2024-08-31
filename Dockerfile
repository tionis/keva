FROM denoland/deno:debian

RUN mkdir /app
WORKDIR /app

COPY ./deno.json ./deno.json
COPY ./deno.lock ./deno.lock
COPY ./vendor ./vendor
COPY ./main.ts ./main.ts

CMD ["deno", "serve", "--allow-env=DENO_KV_ENDPOINT,DENO_KV_ACCESS_TOKEN", "--unstable-kv", "--allow-net=0.0.0.0:8000,dkv.fly.dev", "main.ts"]
