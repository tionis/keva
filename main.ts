#!/bin/env -S deno run --allow-env=DENO_KV_ENDPOINT,DENO_KV_ACCESS_TOKEN --unstable-kv --allow-net=0.0.0.0:8000,dkv.fly.dev
import { Hono } from "hono";
import { JsonPatch } from "https://deno.land/x/json_patch@v0.1.1/mod.ts";
import { JsonPointer } from "https://deno.land/x/json_patch@v0.1.1/mod.ts";

const app = new Hono();
const kv = await Deno.openKv(Deno.env.get("DENO_KV_ENDPOINT"));
const jPointer = new JsonPointer();

interface TokenPermissions {
  WriteRegex: RegExp;
  ReadRegex: RegExp;
}

async function validateToken(token, path, isWrite): Promise<Boolean> {
  if (!token) {
    return false;
  }
  const tokenData = await kv.get(["tokens", token]);
  if (!tokenData.value) {
    return false;
  }
  const permissions = tokenData.value as TokenPermissions;
  if (isWrite) {
    return permissions.WriteRegex.test(path);
  } else {
    return permissions.ReadRegex.test(path);
  }
}

app.get("/rest/:path{.+$}", async (c) => {
  const token = c.req.headers.get("Authorization");
  const { path } = c.req.param();
  const isValid = await validateToken(token, path, false);
  if (!isValid) {
    throw new Error("Unauthorized");
  }
  const { pointer, raw_pointer } = c.req.query();
  const path_parts = path.split("/");
  const result = await kv.get(path_parts);
  if (pointer) {
    const pointedResult = jPointer.apply(result.value, pointer);
    if (raw_pointer) {
      return c.json(pointedResult);
    } else {
      return c.json(pointedResult.target);
    }
  } else {
    return c.json(result.value);
  }
});

Deno.serve(app.fetch);
