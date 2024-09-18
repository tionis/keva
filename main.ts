#!/bin/env -S deno run --allow-env=DENO_KV_ENDPOINT,DENO_KV_ACCESS_TOKEN --unstable-kv --allow-net=0.0.0.0:8000,dkv.fly.dev
import { Hono } from "hono";
import { stream, streamSSE } from "hono/streaming";
import { HTTPException } from "hono/http-exception";
import { JsonPatch } from "https://deno.land/x/json_patch@v0.1.1/mod.ts";
import { JsonPointer } from "https://deno.land/x/json_patch@v0.1.1/mod.ts";
import { JSONObject } from "jsr:@hono/hono@^4.6.1/utils/types";
import { JsonValueType } from "https://deno.land/x/json_patch@v0.1.1/src/utils.ts";

// TODO add support for pubsub (use a mqtt server or patchwork + some hacking as backend)

// TODO add redis like endpoint over HTTP post and also websocket using json encoded wire format
// with redis style commands, support the following types:
// - yjs ...
// - automerge ...
// - object (json object)
// - array (json array)
// - string
// - integer
// - set
// - sorted set
// - sqlite (with local cache based on versionstamp)
// - simple datalog (with local cache based on versionstamp)
// - stream (basically an append only array with a watch?)

const app = new Hono();
const prefix = ["keva"];
const kv = await Deno.openKv(Deno.env.get("DENO_KV_ENDPOINT"));
const jPointer = new JsonPointer();
const jPatch = new JsonPatch();
// const decoder = new TextDecoder();
// const encoder = new TextEncoder();

enum message_qos {
  AT_MOST_ONCE = 0,
  AT_LEAST_ONCE = 1,
  EXACTLY_ONCE = 2,
}

const messageDefaults = {
  qos: message_qos.AT_MOST_ONCE,
  ttl: 31 * 24 * 60 * 60,
};

interface Message {
  value: unknown; // The payload of the message (JSON serializable object or value)
  ttl?: number; // Number of seconds the message should be valid for until delivery conditions are met
  qos?: message_qos; // Quality of service level
  responseChannel?: string; // Channel to send a response to
  sender?: string; // Sender of the message
  sendingTime?: Date; // Time the message was sent
  brokerReceivedTime?: Date; // Time the message was received by the broker
  duplicate?: boolean; // Whether the message is a duplicate (for QoS levels 1 and 2)
}

interface deadManTrigger {
  lastPing: Date;
  lastNotification?: Date;
  notifyDelay: number;
  notifyCooldown?: number;
}

async function cronDeadManTrigger() {
  // TODO use locks/leases etc to ensure only one instance of this cron runs at a time
  console.log([new Date(), "Checking deadManTriggers"]);
  for await (const kventry of kv.list({ prefix: ["deadManTriggers"] })) {
    const entry = kventry.value as deadManTrigger;
    const now = new Date();
    if (
      Math.abs(now.getTime() - entry.lastPing.getTime()) >
      entry.notifyDelay * 1000
    ) {
      if (
        entry.lastNotification === undefined ||
        Math.abs(now.getTime() - entry.lastNotification.getTime()) >
          (entry.notifyCooldown || entry.notifyDelay) * 1000
      ) {
        const name = kventry.key.slice(1).join("/");
        await notify("keva", name, {
          reason: "deadManTrigger",
          lastPing: entry.lastPing,
        });
        entry.lastNotification = now;
        await kv.set(kventry.key, entry);
      }
    }
  }
  console.log([new Date(), "Done checking deadManTriggers"]);
}

Deno.cron("Check for dead man triggers", "*/15 * * * *", cronDeadManTrigger);

interface TokenPermissions {
  WriteRegex?: RegExp;
  ReadRegex?: RegExp;
  // PubSub patterns
  PingRegex?: RegExp;
  NtfyRegex?: RegExp;
  Name?: string;
  Description?: string;
}

enum TokenOperation {
  READ,
  WRITE,
  PING,
  NTFY,
}

async function validateToken(
  token: string | undefined,
  path: string,
  operation: TokenOperation,
): Promise<boolean> {
  const tokenData = await kv.get(["tokens", token || "public"]);
  if (!tokenData.value) {
    return false;
  }
  const permissions = tokenData.value as TokenPermissions;
  switch (operation) {
    case TokenOperation.READ:
      if (!permissions.ReadRegex) {
        return false;
      }
      return permissions.ReadRegex.test(path);
    case TokenOperation.WRITE:
      if (!permissions.WriteRegex) {
        return false;
      }
      return permissions.WriteRegex.test(path);
    case TokenOperation.PING:
      if (!permissions.PingRegex) {
        return false;
      }
      return permissions.PingRegex.test(path);
    case TokenOperation.NTFY:
      if (!permissions.NtfyRegex) {
        return false;
      }
      return permissions.NtfyRegex.test(path);
  }
}

function pathToKey(path: string): string[] {
  return [...prefix, ...path.split("/")];
}

function deadManPathToChannel(path: string): string[] {
  return ["deadManTriggers", ...path.split("/")];
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

async function notify(
  source: string | undefined,
  channel: string | undefined,
  content: object | string,
  silent: boolean | undefined = false,
) {
  const token = Deno.env.get("GUPPI_TELEGRAM_TOKEN");
  if (token === undefined || token === "") {
    throw new Error("Telegram token not set");
  }
  const chatId = "248533143";
  let message = `${source || "unknown"}@${channel || "unknown"}:\n`;
  switch (typeof content) {
    case "string":
      message += content;
      break;
    case "object":
      message += "```json\n" + JSON.stringify(content, null, 2) + "\n```";
      break;
    default:
      message += String(content);
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      parse_mode: "markdown",
      text: message,
      disable_notification: silent,
    }),
  });
  if (resp.status !== 200) {
    console.error(await resp.text());
    throw new Error("Failed to send notification");
  }
}

app
  .get("/rest/:path{.+$}", async (c) => {
    const token = c.req.header("Authorization");
    const { path } = c.req.param();
    if (!(await validateToken(token, path, TokenOperation.READ))) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    const { pointer, raw_pointer } = c.req.query();
    const key = pathToKey(path);
    const result = await kv.get(key);
    if (result.value === null) {
      throw new HTTPException(404, { message: "Not found" });
    }
    const value = result.value as JsonValueType;
    c.header("VERSIONSTAMP", result.versionstamp);
    if (pointer) {
      const pointedResult = jPointer.apply(value, pointer);
      if (raw_pointer) {
        return c.json(pointedResult);
      } else {
        return c.json(pointedResult.target as JSONObject);
      }
    } else {
      return c.json(result.value);
    }
  })
  .put(async (c) => {
    const token = c.req.header("Authorization");
    const { path } = c.req.param();
    if (!(await validateToken(token, path, TokenOperation.WRITE))) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    const expectedVersionStampQuery = c.req.query("versionstamp");
    const key = pathToKey(path);
    const expectedVersionStamp =
      expectedVersionStampQuery === "null" ? null : expectedVersionStampQuery;
    let body;
    const ttl = c.req.query("ttl");
    const opts = ttl ? { expireIn: parseInt(ttl) * 1000 } : undefined;
    try {
      body = await c.req.json();
    } catch (e) {
      throw new HTTPException(400, { message: `Invalid JSON: ${e}` });
    }
    if (expectedVersionStamp) {
      const res = await kv
        .atomic()
        .check({ key, versionstamp: expectedVersionStamp })
        .set(key, body, opts)
        .commit();
      if (!res) {
        throw new Error("Conflict");
      } else {
        return c.json({ status: "success" });
      }
    } else {
      await kv.set(key, body, opts);
      return c.json({ status: "success" });
    }
  })
  .patch(async (c) => {
    const token = c.req.header("Authorization");
    const { path } = c.req.param();
    if (!(await validateToken(token, path, TokenOperation.WRITE))) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    const key = pathToKey(path);
    let patch;
    try {
      patch = await c.req.json();
    } catch (e) {
      throw new HTTPException(400, { message: `Invalid JSON: ${e}` });
    }
    const ttl = c.req.query("ttl");
    const opts = ttl ? { expireIn: parseInt(ttl) * 1000 } : undefined;
    let res = { ok: false };
    while (!res.ok) {
      const result = await kv.get(key);
      if (result.value === null) {
        throw new HTTPException(404, { message: "Not found" });
      }
      const patched = jPatch.patch(result.value as JsonValueType, patch);
      res = await kv.atomic().check(result).set(key, patched, opts).commit();
    }
  });

app.get("/ping", (c) => {
  c.status(200);
  return c.body("pong");
});

app.get("/ping/:channel{.+$}", async (c) => {
  const { channel } = c.req.param();
  const token = c.req.header("Authorization") || "public";
  if (!(await validateToken(token, channel, TokenOperation.PING))) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }
  const now = new Date();
  let res = { ok: false };
  while (!res.ok) {
    const entry = await kv.get(deadManPathToChannel(channel));
    if (entry.value === null) {
      throw new HTTPException(404, { message: "Ping target does not exist" });
    }
    const update = entry.value as deadManTrigger;
    update.lastPing = now;
    res = await kv.atomic().check(entry).set(entry.key, update).commit();
  }
  c.status(200);
  return c.body("OK");
});

app.post("/ntfy/:channel{.+$}", async (c) => {
  const token = c.req.header("Authorization");
  const { channel } = c.req.param();
  if (!(await validateToken(token, channel, TokenOperation.NTFY))) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }
  const tokenRes = await kv.get(["tokens", token || "public"]);
  let source: string;
  if (tokenRes.value) {
    source = (tokenRes.value as TokenPermissions).Name || "unknown";
  } else {
    source = "unknown";
  }
  const silent = c.req.query("silent") === "true";
  const { format } = c.req.query();
  switch (format) {
    case "json":
      await notify(source, channel, await c.req.json(), silent);
      c.status(200);
      return c.body("OK");
    case "apprise_json": {
      const req_json = await c.req.json();
      const message = `# ${req_json.title || "no title"} (${
        req_json.type || "no type"
      })\n${req_json.message}`;
      await notify(source, channel, message, silent);
      c.status(200);
      return c.body("OK");
    }
    case "md":
    case "markdown":
    default:
      await notify(source, channel, await c.req.text(), silent);
      c.status(200);
      return c.body("OK");
  }
});

app.post("/api/watch", async (c) => {
  const raw_paths: string[][] = (await c.req.json()) as string[][];
  const token: string | undefined = c.req.header("Authorization");
  let { format } = c.req.query(); //default format to full
  format = format || "full";
  for (const path of raw_paths) {
    const isValid = await validateToken(
      token,
      path.join("/"),
      TokenOperation.READ,
    );
    if (!isValid) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }
  }
  if (format !== "full" && format !== "diff") {
    throw new HTTPException(400, { message: "Invalid format" });
  }
  const paths = raw_paths.map((path) => [...prefix, ...path]);
  const noSSE = c.req.query("noSSE");
  const stateCache: Map<Array<string>, unknown> = new Map();

  if (format === "diff") {
    for (const path of paths) {
      const result = await kv.get(path);
      stateCache.set(path, result.value);
    }
  }

  if (noSSE) {
    return stream(c, async (stream) => {
      const watch = kv.watch(paths);
      // stream.onAbort(() => {
      //   console.log("Aborted!");
      // });
      for await (const events of watch) {
        for (const event of events) {
          if (event) {
            if (format === "full") {
              event.key = event.key.slice(prefix.length);
              stream.write(JSON.stringify(event) + "\n");
            } else {
              let oldState = stateCache.get(event.key as Array<string>);
              stateCache.set(event.key as Array<string>, event.value);
              oldState = oldState || {};
              const diff = jPatch.diff(
                oldState as JsonValueType,
                event.value as JsonValueType,
              );
              stream.write(
                JSON.stringify({
                  key: event.key.slice(prefix.length),
                  diff: diff,
                }) + "\n",
              );
            }
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
            if (format === "full") {
              event.key = event.key.slice(prefix.length);
              stream.writeSSE({
                data: JSON.stringify(event),
                //event: "update",
                id: String(id++),
              });
            } else {
              let oldState = stateCache.get(event.key as Array<string>);
              stateCache.set(event.key as Array<string>, event.value);
              oldState = oldState || {};
              const diff = jPatch.diff(
                oldState as JsonValueType,
                event.value as JsonValueType,
              );
              stream.writeSSE({
                data: JSON.stringify({
                  key: event.key.slice(prefix.length),
                  diff: diff,
                }),
                //event: "update",
                id: String(id++),
              });
            }
          }
        }
      }
    });
  }
});

// Some functions for my personal use
// Send me the weather each morning
Deno.cron("Weather", "0 8 * * *", async () => {
  const location = kv.get([...prefix, "tionis", "location"]) || "Passau";
  const weather = await (
    await fetch(`https://wttr.in/${location}?format=j1`)
  ).json();
  await notify(
    // TODO improve message
    "keva",
    "weather",
    {
      Feels_Like: weather.current_condition.FeelsLikeC,
      Pressure: weather.current_condition.pressure,
      Humidity: weather.current_condition.humidity,
      Tempeature: weather.current_condition.temp_C,
      UV: weather.current_condition.uv_index,
      Visibility: weather.current_condition.visibility,
      Description: weather.current_condition.weatherDesc[0].value,
    },
    true,
  );
});

export default {
  fetch: app.fetch,
};
//Deno.serve(app.fetch);
