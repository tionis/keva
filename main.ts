#!/bin/env -S deno run --allow-env=DENO_KV_ENDPOINT,DENO_KV_ACCESS_TOKEN --unstable-kv --allow-net=0.0.0.0:8000,dkv.fly.dev
import { Hono } from "hono";
import { stream, streamSSE, streamText } from "hono/streaming";
import { HTTPException } from "hono/http-exception";
import { JsonPatch } from "https://deno.land/x/json_patch@v0.1.1/mod.ts";
import { JsonPointer } from "https://deno.land/x/json_patch@v0.1.1/mod.ts";

const app = new Hono();
const prefix = ["keva"];
const kv = await Deno.openKv(Deno.env.get("DENO_KV_ENDPOINT"));
const jPointer = new JsonPointer();
const jPatch = new JsonPatch();
// const decoder = new TextDecoder();
// const encoder = new TextEncoder();

interface TokenPermissions {
  WriteRegex: RegExp;
  ReadRegex: RegExp;
}

async function validateToken(
  token: string,
  path: string,
  isWrite: boolean,
): Promise<boolean> {
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

function pathToKey(path: string): string[] {
  return [...prefix, ...path.split("/")];
}

app
  .get("/rest/:path{.+$}", async (c) => {
    const token = c.req.header("Authorization");
    const { path } = c.req.param();
    const isValid = await validateToken(token, path, false);
    if (!isValid) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    const { pointer, raw_pointer } = c.req.query();
    const key = pathToKey(path);
    const result = await kv.get(key);
    c.header("VERSIONSTAMP", result.versionstamp);
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
  })
  .post(async (c) => {
    const token = c.req.header("Authorization");
    const { path } = c.req.param();
    const isValid = await validateToken(token, path, true);
    if (!isValid) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    const expectedVersionStampQuery = c.req.query("versionstamp");
    const key = pathToKey(path);
    const expectedVersionStamp =
      expectedVersionStampQuery === "null" ? null : expectedVersionStampQuery;
    let body;
    try {
      body = await c.req.json();
    } catch (e) {
      throw new HTTPException(400, { message: `Invalid JSON: ${e}` });
    }
    if (expectedVersionStamp) {
      const res = await kv
        .atomic()
        .check({ key, versionstamp: expectedVersionStamp })
        .set(key, body)
        .commit();
      if (!res) {
        throw new Error("Conflict");
      } else {
        return c.json({ status: "success" });
      }
    } else {
      await kv.set(key, body);
      return c.json({ status: "success" });
    }
  })
  .put(async (c) => {
    const token = c.req.header("Authorization");
    const { path } = c.req.param();
    const isValid = await validateToken(token, path, true);
    if (!isValid) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    const key = pathToKey(path);
    let patch;
    try {
      patch = await c.req.json();
    } catch (e) {
      throw new HTTPException(400, { message: `Invalid JSON: ${e}` });
    }
    let done = false;
    while (!done) {
      const result = await kv.get(key);
      const patched = jPatch.patch(result.value, patch);
      const res = await kv
        .atomic()
        .check({ key, versionstamp: result.versionstamp })
        .set(key, patched)
        .commit();
      done = res.ok;
    }
  });

app.post("/api/watch", async (c) => {
  const paths: string[][] = (await c.req.json()) as string[][];
  const token: string = c.req.header("Authorization");
  for (const path of paths) {
    const isValid = await validateToken(token, path.join("/"), false);
    if (!isValid) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }
  }
  const watch = kv.watch(paths);
  let id = 0;

  return streamSSE(async (stream) => {
    for await (const events of watch) {
      console.log({ events });
      for (const event of events) {
        if (event) {
          stream.writeSSE({
            data: JSON.stringify(event),
            event: "update", // TODO embed channel name
            id: String(id++),
          });
        }
      }
    }
  });
});

export default {
  fetch: app.fetch,
};
//Deno.serve(app.fetch);
