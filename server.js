import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import mysql from "mysql2/promise";

const root = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(fs.readFileSync(path.join(root, "data/tomica-catalog.json"), "utf8"));
const MAX_OFFICIAL_NUMBER = Number(catalog.total);
const PORT = Number(process.env.PORT || 3000);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_QUANTITY = 9999;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/avif", "avif"],
  ["image/heic", "heic"],
  ["image/heif", "heif"],
]);

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");

const dbUrl = new URL(process.env.DATABASE_URL);
if (!new Set(["mysql:", "mysql2:"]).has(dbUrl.protocol)) {
  throw new Error("DATABASE_URL must use the mysql protocol.");
}
const databaseName = decodeURIComponent(dbUrl.pathname.replace(/^\/+/, ""));
if (!dbUrl.hostname || !databaseName) throw new Error("DATABASE_URL must include a host and database name.");

const pool = mysql.createPool({
  host: dbUrl.hostname,
  port: Number(dbUrl.port || 3306),
  user: decodeURIComponent(dbUrl.username),
  password: decodeURIComponent(dbUrl.password),
  database: databaseName,
  ssl: { rejectUnauthorized: true },
  waitForConnections: true,
  connectionLimit: 8,
  queueLimit: 100,
  connectTimeout: 15000,
  enableKeepAlive: true,
  timezone: "Z",
});

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use("/api", express.json({ limit: "128kb" }));

function rateLimit({ windowMs, max }) {
  const clients = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || "unknown";
    let entry = clients.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      clients.set(key, entry);
    }
    entry.count += 1;
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, max - entry.count)));
    if (entry.count > max) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
      return res.status(429).json({ error: "操作が集中しています。少し待ってからもう一度お試しください。" });
    }
    if (clients.size > 10000) {
      for (const [client, record] of clients) if (now >= record.resetAt) clients.delete(client);
    }
    return next();
  };
}

const readLimit = rateLimit({ windowMs: 60_000, max: 90 });
const writeLimit = rateLimit({ windowMs: 60_000, max: 45 });
const uploadLimit = rateLimit({ windowMs: 10 * 60_000, max: 8 });

const schemaReady = (async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tomica_shared_state (
      id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
      revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
      last_undo LONGTEXT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tomica_official_counts (
      number SMALLINT UNSIGNED NOT NULL PRIMARY KEY,
      quantity INT UNSIGNED NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tomica_custom_items (
      id CHAR(36) NOT NULL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      image_url VARCHAR(512) NOT NULL,
      quantity INT UNSIGNED NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      deleted_at TIMESTAMP NULL DEFAULT NULL,
      INDEX active_items (deleted_at, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query("INSERT IGNORE INTO tomica_shared_state (id, revision, last_undo) VALUES (1, 0, NULL)");
})();

function jsonState(res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
}

function normalizeCounts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const counts = {};
  for (const [rawNumber, rawQuantity] of Object.entries(value)) {
    const number = Number(rawNumber);
    const quantity = Number(rawQuantity);
    if (
      Number.isInteger(number) && number >= 1 && number <= MAX_OFFICIAL_NUMBER &&
      Number.isInteger(quantity) && quantity > 0 && quantity <= MAX_QUANTITY
    ) counts[number] = quantity;
  }
  return counts;
}

function normalizeName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/[\u0000-\u001f\u007f]/g, "");
  if (!name || [...name].length > 120) return null;
  return name;
}

function validImagePath(value) {
  return typeof value === "string" &&
    /^\/manus-storage\/tomica\/custom\/[0-9a-f-]{36}\.(jpg|png|webp|avif|heic|heif)$/i.test(value);
}

function normalizeCustomItems(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const item of value.slice(0, 500)) {
    const id = typeof item?.id === "string" ? item.id : "";
    const name = normalizeName(item?.name);
    const imageUrl = item?.imageUrl ?? item?.image_url;
    const quantity = Number(item?.quantity ?? item?.count ?? 0);
    if (!UUID_PATTERN.test(id) || !name || !validImagePath(imageUrl)) continue;
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > MAX_QUANTITY) continue;
    result.push({ id, name, imageUrl, quantity });
  }
  return result;
}

async function getState() {
  await schemaReady;
  const [[meta]] = await pool.query("SELECT revision, last_undo, updated_at FROM tomica_shared_state WHERE id = 1");
  const [countRows] = await pool.query("SELECT number, quantity FROM tomica_official_counts WHERE quantity > 0 ORDER BY number");
  const [customRows] = await pool.query(
    "SELECT id, name, image_url, quantity, created_at FROM tomica_custom_items WHERE deleted_at IS NULL ORDER BY created_at, id",
  );
  let lastUndo = null;
  try {
    lastUndo = meta?.last_undo ? JSON.parse(meta.last_undo) : null;
  } catch {
    lastUndo = null;
  }
  return {
    revision: Number(meta?.revision || 0),
    counts: Object.fromEntries(countRows.map((row) => [Number(row.number), Number(row.quantity)])),
    customItems: customRows.map((row) => ({
      id: row.id,
      name: row.name,
      imageUrl: row.image_url,
      quantity: Number(row.quantity),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    })),
    canUndo: Boolean(lastUndo),
    updatedAt: meta?.updated_at instanceof Date ? meta.updated_at.toISOString() : String(meta?.updated_at || ""),
  };
}

async function mutate(operation) {
  await schemaReady;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[meta]] = await connection.query("SELECT revision, last_undo FROM tomica_shared_state WHERE id = 1 FOR UPDATE");
    const result = await operation(connection, meta);
    if (result?.changed) {
      await connection.query(
        "UPDATE tomica_shared_state SET revision = revision + 1, last_undo = ?, updated_at = UTC_TIMESTAMP() WHERE id = 1",
        [result.undo ? JSON.stringify(result.undo) : null],
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return getState();
}

function validOfficialNumber(raw) {
  const number = Number(raw);
  return Number.isInteger(number) && number >= 1 && number <= MAX_OFFICIAL_NUMBER ? number : null;
}

function validId(raw) {
  return typeof raw === "string" && UUID_PATTERN.test(raw) ? raw : null;
}

function formatImagePath(extension) {
  return `/manus-storage/tomica/custom/${crypto.randomUUID()}.${extension}`;
}

async function storeImage(buffer, contentType, extension) {
  const apiUrl = process.env.MANUS_API_URL;
  const apiKey = process.env.MANUS_API_KEY;
  if (!apiUrl || !apiKey) throw new Error("Storage service is unavailable.");
  const imagePath = formatImagePath(extension);
  const base = apiUrl.replace(/\/+$/, "");
  const presignResponse = await fetch(
    `${base}/v1/storage/presign/put?path=${encodeURIComponent(imagePath.replace(/^\/manus-storage\//, ""))}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  const presignData = await presignResponse.json().catch(() => ({}));
  if (!presignResponse.ok || typeof presignData.url !== "string") {
    console.error("[storage] presign failed with status", presignResponse.status);
    throw new Error("画像保存先を準備できませんでした。");
  }
  const putResponse = await fetch(presignData.url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: buffer,
  });
  if (!putResponse.ok) {
    console.error("[storage] upload failed with status", putResponse.status);
    throw new Error("画像を保存できませんでした。");
  }
  return imagePath;
}

app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

app.get("/api/state", readLimit, async (_req, res, next) => {
  try {
    jsonState(res);
    res.json(await getState());
  } catch (error) {
    next(error);
  }
});

app.post("/api/import", writeLimit, async (req, res, next) => {
  try {
    jsonState(res);
    const counts = normalizeCounts(req.body?.counts);
    const customItems = normalizeCustomItems(req.body?.customItems);
    const state = await mutate(async (connection) => {
      let changed = false;
      for (const [numberText, quantity] of Object.entries(counts)) {
        const number = Number(numberText);
        const [[current]] = await connection.query("SELECT quantity FROM tomica_official_counts WHERE number = ? FOR UPDATE", [number]);
        if (quantity > Number(current?.quantity || 0)) {
          await connection.query(
            "INSERT INTO tomica_official_counts (number, quantity) VALUES (?, ?) ON DUPLICATE KEY UPDATE quantity = VALUES(quantity)",
            [number, quantity],
          );
          changed = true;
        }
      }
      for (const item of customItems) {
        const [result] = await connection.query(
          "INSERT IGNORE INTO tomica_custom_items (id, name, image_url, quantity) VALUES (?, ?, ?, ?)",
          [item.id, item.name, item.imageUrl, item.quantity],
        );
        if (result.affectedRows > 0) changed = true;
      }
      return changed ? { changed: true, undo: null } : { changed: false };
    });
    res.json(state);
  } catch (error) {
    next(error);
  }
});

app.post("/api/counts/official/:number/increment", writeLimit, async (req, res, next) => {
  try {
    jsonState(res);
    const number = validOfficialNumber(req.params.number);
    if (!number) return res.status(400).json({ error: "商品番号が正しくありません。" });
    const state = await mutate(async (connection) => {
      const [[row]] = await connection.query("SELECT quantity FROM tomica_official_counts WHERE number = ? FOR UPDATE", [number]);
      const before = Number(row?.quantity || 0);
      if (before >= MAX_QUANTITY) return { changed: false };
      await connection.query(
        "INSERT INTO tomica_official_counts (number, quantity) VALUES (?, 1) ON DUPLICATE KEY UPDATE quantity = quantity + 1",
        [number],
      );
      return { changed: true, undo: { kind: "official-count", number, before } };
    });
    res.json(state);
  } catch (error) {
    next(error);
  }
});

app.put("/api/counts/official/:number/reset", writeLimit, async (req, res, next) => {
  try {
    jsonState(res);
    const number = validOfficialNumber(req.params.number);
    if (!number) return res.status(400).json({ error: "商品番号が正しくありません。" });
    const state = await mutate(async (connection) => {
      const [[row]] = await connection.query("SELECT quantity FROM tomica_official_counts WHERE number = ? FOR UPDATE", [number]);
      const before = Number(row?.quantity || 0);
      if (before === 0) return { changed: false };
      await connection.query("DELETE FROM tomica_official_counts WHERE number = ?", [number]);
      return { changed: true, undo: { kind: "official-count", number, before } };
    });
    res.json(state);
  } catch (error) {
    next(error);
  }
});

app.post("/api/counts/custom/:id/increment", writeLimit, async (req, res, next) => {
  try {
    jsonState(res);
    const id = validId(req.params.id);
    if (!id) return res.status(400).json({ error: "登録車両のIDが正しくありません。" });
    const state = await mutate(async (connection) => {
      const [[row]] = await connection.query(
        "SELECT quantity FROM tomica_custom_items WHERE id = ? AND deleted_at IS NULL FOR UPDATE",
        [id],
      );
      if (!row) return { changed: false };
      const before = Number(row.quantity);
      if (before >= MAX_QUANTITY) return { changed: false };
      await connection.query("UPDATE tomica_custom_items SET quantity = quantity + 1 WHERE id = ?", [id]);
      return { changed: true, undo: { kind: "custom-count", id, before } };
    });
    res.json(state);
  } catch (error) {
    next(error);
  }
});

app.put("/api/counts/custom/:id/reset", writeLimit, async (req, res, next) => {
  try {
    jsonState(res);
    const id = validId(req.params.id);
    if (!id) return res.status(400).json({ error: "登録車両のIDが正しくありません。" });
    const state = await mutate(async (connection) => {
      const [[row]] = await connection.query(
        "SELECT quantity FROM tomica_custom_items WHERE id = ? AND deleted_at IS NULL FOR UPDATE",
        [id],
      );
      if (!row || Number(row.quantity) === 0) return { changed: false };
      const before = Number(row.quantity);
      await connection.query("UPDATE tomica_custom_items SET quantity = 0 WHERE id = ?", [id]);
      return { changed: true, undo: { kind: "custom-count", id, before } };
    });
    res.json(state);
  } catch (error) {
    next(error);
  }
});

app.post("/api/custom-image", uploadLimit, express.raw({ type: "image/*", limit: MAX_IMAGE_BYTES }), async (req, res, next) => {
  try {
    jsonState(res);
    const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    const extension = IMAGE_TYPES.get(contentType);
    if (!extension) return res.status(415).json({ error: "JPEG、PNG、WebP、AVIF、HEIC形式の画像を選んでください。" });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: "画像ファイルを選んでください。" });
    if (req.body.length > MAX_IMAGE_BYTES) return res.status(413).json({ error: "画像は8MB以下にしてください。" });
    const imageUrl = await storeImage(req.body, contentType, extension);
    res.status(201).json({ imageUrl });
  } catch (error) {
    next(error);
  }
});

app.post("/api/custom-items", writeLimit, async (req, res, next) => {
  try {
    jsonState(res);
    const name = normalizeName(req.body?.name);
    const imageUrl = req.body?.imageUrl;
    if (!name) return res.status(400).json({ error: "名前を120文字以内で入力してください。" });
    if (!validImagePath(imageUrl)) return res.status(400).json({ error: "写真をアップロードしてください。" });
    const id = crypto.randomUUID();
    const state = await mutate(async (connection) => {
      await connection.query(
        "INSERT INTO tomica_custom_items (id, name, image_url, quantity) VALUES (?, ?, ?, 0)",
        [id, name, imageUrl],
      );
      return { changed: true, undo: { kind: "custom-add", id } };
    });
    res.status(201).json(state);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/custom-items/:id", writeLimit, async (req, res, next) => {
  try {
    jsonState(res);
    const id = validId(req.params.id);
    if (!id) return res.status(400).json({ error: "登録車両のIDが正しくありません。" });
    const state = await mutate(async (connection) => {
      const [result] = await connection.query(
        "UPDATE tomica_custom_items SET deleted_at = UTC_TIMESTAMP() WHERE id = ? AND deleted_at IS NULL",
        [id],
      );
      if (result.affectedRows === 0) return { changed: false };
      return { changed: true, undo: { kind: "custom-delete", id } };
    });
    res.json(state);
  } catch (error) {
    next(error);
  }
});

app.post("/api/undo", writeLimit, async (_req, res, next) => {
  try {
    jsonState(res);
    const state = await mutate(async (connection, meta) => {
      let undo;
      try {
        undo = meta?.last_undo ? JSON.parse(meta.last_undo) : null;
      } catch {
        undo = null;
      }
      if (!undo) return { changed: false };
      if (undo.kind === "official-count" && validOfficialNumber(undo.number)) {
        if (Number(undo.before) > 0) {
          await connection.query(
            "INSERT INTO tomica_official_counts (number, quantity) VALUES (?, ?) ON DUPLICATE KEY UPDATE quantity = VALUES(quantity)",
            [undo.number, Number(undo.before)],
          );
        } else {
          await connection.query("DELETE FROM tomica_official_counts WHERE number = ?", [undo.number]);
        }
      } else if (undo.kind === "custom-count" && validId(undo.id)) {
        await connection.query(
          "UPDATE tomica_custom_items SET quantity = ? WHERE id = ? AND deleted_at IS NULL",
          [Math.max(0, Number(undo.before) || 0), undo.id],
        );
      } else if (undo.kind === "custom-add" && validId(undo.id)) {
        await connection.query(
          "UPDATE tomica_custom_items SET deleted_at = UTC_TIMESTAMP() WHERE id = ? AND deleted_at IS NULL",
          [undo.id],
        );
      } else if (undo.kind === "custom-delete" && validId(undo.id)) {
        await connection.query("UPDATE tomica_custom_items SET deleted_at = NULL WHERE id = ?", [undo.id]);
      }
      return { changed: true, undo: null };
    });
    res.json(state);
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.join(root, "dist"), { index: "index.html", etag: true }));
app.use((_req, res) => res.status(404).json({ error: "ページが見つかりません。" }));

app.use((error, _req, res, _next) => {
  if (res.headersSent) return;
  if (error?.type === "entity.too.large" || error?.status === 413) {
    return res.status(413).json({ error: "画像は8MB以下にしてください。" });
  }
  console.error("[server] request failed:", error?.message || "unknown error");
  return res.status(500).json({ error: "保存に失敗しました。少し待ってからもう一度お試しください。" });
});

await schemaReady;
app.listen(PORT, "0.0.0.0", () => console.log(`Tomica server listening on ${PORT}`));
