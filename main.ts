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

enum KevaObjectType {
  STRING,
  INTEGER,
  SIMPLE_DATALOG,
  SQLITE,
  SET,
  // SORTED_SET,
  ARRAY, // Aka LIST?
  OBJECT, // json object (the default)
}

function getKevaObjectType(val: unknown): KevaObjectType {
  switch (typeof val) {
    case "string":
      return KevaObjectType.STRING;
    case "number":
      return KevaObjectType.INTEGER;
    case "object":
      if (Array.isArray(val)) {
        return KevaObjectType.ARRAY;
      } else {
        // check type key in object
        const objectType = (val as Record<string, unknown>).type;
        switch (objectType) {
          case "sdl":
            return KevaObjectType.SIMPLE_DATALOG;
          case "sqlite":
            return KevaObjectType.SQLITE;
          case "set":
            return KevaObjectType.SET;
          default:
            return KevaObjectType.OBJECT;
        }
      }
    default:
      throw new Error("Unsupported type");
  }
}
// TODO add support for streams and pubsub

// TODO add lcoal cache for datalog and sqlite stores, they store the versionstamp of their state

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
  .put(async (c) => {
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
  .patch(async (c) => {
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
  })
  .post(async (c) => {
    const token = c.req.header("Authorization");
    const { path } = c.req.param();
    const isValid = await validateToken(token, path, true);
    if (!isValid) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    // message is a json array with the first element specifying the operation
    // and the rest of the elements specifying the arguments

    const args = await c.req.json();
    if (!Array.isArray(args)) {
      throw new HTTPException(400, { message: "Invalid JSON" });
    }
    const rawVal = await kv.get(pathToKey(path));
    const valType = getKevaObjectType(rawVal.value);
    // TODO forward the request to the appropriate handler based on the type
    //   - string/bitmap
    //   - integer
    //   - array
    //   - set
    //   - simple datalog
    //     - add (add x new facts in a transaction)
    //     - query (execute a datalog query)
    //   - sqlite
    //     - exec (execute a sqlite query in a in-memory db loaded with the data from object)
    // handler saves resulting new dataset (with optimistic locking) and returns the result
  });

app.post("/api/watch", async (c) => {
  const raw_paths: string[][] = (await c.req.json()) as string[][];
  const token: string = c.req.header("Authorization");
  for (const path of raw_paths) {
    const isValid = await validateToken(token, path.join("/"), false);
    if (!isValid) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }
  }
  const paths = raw_paths.map((path) => [...prefix, ...path]);
  const noSSE = c.req.query("noSSE");
  if (noSSE) {
    return stream(c, async (stream) => {
      const watch = kv.watch(paths);
      // stream.onAbort(() => {
      //   console.log("Aborted!");
      // });
      for await (const events of watch) {
        for (const event of events) {
          if (event) {
            event.key = event.key.slice(prefix.length);
            stream.write(JSON.stringify(event) + "\n");
          }
        }
      }
    });
  } else {
    return streamSSE(c, async (stream) => {
      const watch = kv.watch(paths);
      let id = 0;
      for await (const events of watch) {
        for (const event of events) {
          if (event) {
            event.key = event.key.slice(prefix.length);
            stream.writeSSE({
              data: JSON.stringify(event),
              event: "update", // TODO embed channel name
              id: String(id++),
            });
          }
        }
      }
    });
  }
});

export default {
  fetch: app.fetch,
};
//Deno.serve(app.fetch);
