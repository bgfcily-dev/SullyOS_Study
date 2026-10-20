// utils/memoryPalace/eventDate.ts
function normalizeEventDate(value) {
  if (typeof value !== "string" || !/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(value)) return void 0;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || month !== void 0 && (month < 1 || month > 12)) return void 0;
  if (day !== void 0) {
    const date = /* @__PURE__ */ new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return void 0;
  }
  return value;
}

// worker/memory-sync/src/eventBoxRetirement.ts
var snapshotColumns = ["memory_id", "vector_key", "namespace_key", "char_id", "content", "vector_json", "dimensions", "model", "room", "importance", "tags_json", "mood", "valence", "arousal", "created_at", "last_accessed_at", "access_count", "pinned_until", "source_id", "origin", "archived", "is_summary", "event_box_id", "metadata_json"];
var eventBoxRetirementSchema = [
  `CREATE TABLE IF NOT EXISTS memory_event_box_policy (char_id TEXT PRIMARY KEY, disabled INTEGER NOT NULL DEFAULT 1 CHECK(disabled = 1))`,
  `CREATE TABLE IF NOT EXISTS memory_event_box_backup (memory_id TEXT PRIMARY KEY, char_id TEXT NOT NULL, archived INTEGER NOT NULL, is_summary INTEGER NOT NULL, event_box_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS memory_event_box_summary_backup (memory_id TEXT PRIMARY KEY, char_id TEXT NOT NULL, snapshot_json TEXT NOT NULL)`,
  // One policy insert performs the whole migration atomically, including backups.
  `CREATE TRIGGER IF NOT EXISTS memory_retire_event_boxes AFTER INSERT ON memory_event_box_policy
  BEGIN
    INSERT OR IGNORE INTO memory_event_box_backup SELECT memory_id, char_id, archived, is_summary, event_box_id FROM memory_vectors WHERE char_id = NEW.char_id;
    INSERT OR IGNORE INTO memory_event_box_summary_backup SELECT memory_id, char_id, json_object(${snapshotColumns.map((column) => `'${column}', ${column}`).join(", ")}) FROM memory_vectors WHERE char_id = NEW.char_id AND is_summary = 1;
    UPDATE memory_vectors SET archived = CASE WHEN is_summary = 1 THEN 1 WHEN event_box_id IS NOT NULL THEN 0 ELSE archived END, event_box_id = NULL WHERE char_id = NEW.char_id;
  END`,
  ...["INSERT", "UPDATE"].map((operation) => `CREATE TRIGGER IF NOT EXISTS memory_no_event_boxes_${operation.toLowerCase()} AFTER ${operation} ON memory_vectors
  WHEN EXISTS (SELECT 1 FROM memory_event_box_policy WHERE char_id = NEW.char_id)
    AND (NEW.event_box_id IS NOT NULL OR (NEW.is_summary = 1 AND NEW.archived = 0)
      OR (NEW.is_summary = 0 AND EXISTS (SELECT 1 FROM memory_event_box_summary_backup WHERE memory_id = NEW.memory_id)))
  BEGIN
    UPDATE memory_vectors SET
      is_summary = CASE WHEN EXISTS (SELECT 1 FROM memory_event_box_summary_backup WHERE memory_id = NEW.memory_id) THEN 1 ELSE NEW.is_summary END,
      archived = CASE WHEN NEW.is_summary = 1 OR EXISTS (SELECT 1 FROM memory_event_box_summary_backup WHERE memory_id = NEW.memory_id) THEN 1 WHEN NEW.event_box_id IS NOT NULL THEN 0 ELSE NEW.archived END,
      event_box_id = NULL
    WHERE memory_id = NEW.memory_id;
  END`)
];

// utils/memoryPalace/changeContract.ts
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter((key) => value[key] !== void 0).map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function validateChangeDraft(value, target, sources) {
  if (!value || typeof value !== "object") throw new Error("\u4FEE\u6539\u63D0\u6848\u683C\u5F0F\u65E0\u6548");
  const draft = value;
  const kind = target.metadata?.kind;
  if (target.archived || target.is_summary || kind === "identity" || kind === "reflection" || target.metadata?.status && target.metadata.status !== "active") throw new Error("\u53EA\u80FD\u9488\u5BF9\u6709\u6548\u4E8B\u5B9E\u6216\u672A\u5206\u7C7B\u539F\u59CB\u8BB0\u5FC6\u63D0\u51FA\u4FEE\u6539");
  if (draft.action !== "correct_fact" && draft.action !== "revise_reflection") throw new Error("\u4FEE\u6539\u7C7B\u578B\u65E0\u6548");
  if (draft.action === "revise_reflection" && kind !== "event") throw new Error("\u66F4\u65B0\u611F\u60F3\u5FC5\u987B\u5173\u8054\u660E\u786E\u7684\u4E8B\u5B9E\u8BB0\u5F55");
  if (draft.target_id !== target.memory_id) throw new Error("\u4FEE\u6539\u76EE\u6807\u4E0E\u539F\u8BB0\u5FC6\u4E0D\u7B26");
  const content = typeof draft.content === "string" ? draft.content.trim() : "";
  const reason = typeof draft.reason === "string" ? draft.reason.trim() : "";
  if (!content || content.length > 12e3 || !reason || reason.length > 1e3) throw new Error("\u4FEE\u6539\u6B63\u6587\u6216\u7406\u7531\u65E0\u6548");
  if (!Array.isArray(draft.evidence) || !draft.evidence.length || draft.evidence.length > 4 || !draft.evidence.every((quote) => typeof quote === "string" && quote.trim().length >= 2 && quote.length <= 2e3 && sources.some((source) => source.content.includes(quote)))) throw new Error("\u4FEE\u6539\u63D0\u6848\u7F3A\u5C11\u672C\u6B21\u5BF9\u8BDD\u4E2D\u7684\u539F\u53E5\u8BC1\u636E");
  const evidence = draft.evidence;
  if (!sources.some((source) => source.role === "user" && evidence.some((quote) => source.content.includes(quote)))) throw new Error("\u4FEE\u6539\u63D0\u6848\u5FC5\u987B\u6709\u7528\u6237\u7684\u65B0\u4FE1\u606F");
  if (draft.action === "revise_reflection" && !sources.some((source) => source.role === "assistant" && evidence.some((quote) => source.content.includes(quote)))) throw new Error("\u65B0\u611F\u60F3\u5FC5\u987B\u6765\u81EA\u89D2\u8272\u672C\u6B21\u660E\u786E\u8868\u8FBE\u7684\u7406\u89E3");
  if (draft.confidence !== void 0 && (typeof draft.confidence !== "number" || !Number.isFinite(draft.confidence) || draft.confidence < 0 || draft.confidence > 1)) throw new Error("\u7F6E\u4FE1\u5EA6\u5FC5\u987B\u5728 0\u20131 \u4E4B\u95F4");
  if (draft.mood !== void 0 && (typeof draft.mood !== "string" || draft.mood.length > 40)) throw new Error("\u60C5\u7EEA\u6807\u7B7E\u65E0\u6548");
  return { target_id: target.memory_id, action: draft.action, content, reason, evidence, ...draft.confidence === void 0 ? {} : { confidence: draft.confidence }, ...draft.action !== "revise_reflection" || draft.mood === void 0 ? {} : { mood: draft.mood } };
}

// worker/memory-sync/src/memoryChanges.ts
var memoryChangesSchema = [
  `CREATE TABLE IF NOT EXISTS memory_change_proposals (id TEXT PRIMARY KEY, char_id TEXT NOT NULL, target_id TEXT NOT NULL, action TEXT NOT NULL, before_json TEXT NOT NULL, draft_json TEXT NOT NULL, source_json TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')), created_at INTEGER NOT NULL, resolved_at INTEGER, result_json TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_changes_pending ON memory_change_proposals(char_id,status,created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS memory_change_guards (proposal_id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid = 1))`
];
var metadata = (row) => JSON.parse(row.metadata_json || "{}");
var active = (row) => !row.archived && !row.is_summary && (!metadata(row).status || metadata(row).status === "active");
var versionFields = ["memory_id", "char_id", "content", "metadata_json", "archived", "is_summary", "vector_key", "namespace_key", "vector_json", "dimensions", "model", "room", "importance", "tags_json", "mood", "valence", "arousal", "created_at", "last_accessed_at", "access_count", "pinned_until", "source_id", "origin", "event_box_id"];
async function handleMemoryChanges(request, env, url, svc) {
  const load = (id, charId2) => env.DB.prepare("SELECT * FROM memory_vectors WHERE memory_id = ? AND char_id = ?").bind(id, charId2).first();
  const snapshot = (row) => {
    if (!row) return null;
    const value = svc.publicMemory(row);
    delete value.vector;
    return value;
  };
  const publicProposal = (row) => {
    const before2 = JSON.parse(row.before_json);
    return { ...JSON.parse(row.draft_json), id: row.id, char_id: row.char_id, status: row.status, created_at: row.created_at, before: snapshot(before2.target), current_reflection: snapshot(before2.current) };
  };
  const fail = (error, status = 400) => svc.json({ error }, status);
  const root = "/memory/change-proposals";
  if (url.pathname === root && request.method === "GET") {
    const charId2 = url.searchParams.get("char_id")?.trim();
    if (!charId2) return fail("\u5FC5\u987B\u6307\u5B9A\u5F53\u524D\u89D2\u8272");
    const status = url.searchParams.get("status") || "pending";
    if (!["pending", "approved", "rejected"].includes(status)) return fail("\u63D0\u6848\u72B6\u6001\u65E0\u6548");
    const offset = Math.max(0, Math.trunc(Number(url.searchParams.get("offset")) || 0));
    const rows = await env.DB.prepare("SELECT * FROM memory_change_proposals WHERE char_id = ? AND status = ? ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET ?").bind(charId2, status, offset).all();
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM memory_change_proposals WHERE char_id = ? AND status = ?").bind(charId2, status).first();
    return svc.json({ proposals: rows.results.map(publicProposal), total: count?.n || 0 });
  }
  const input = await request.json();
  const charId = typeof input.char_id === "string" ? input.char_id.trim() : "";
  if (!charId) return fail("\u5FC5\u987B\u6307\u5B9A\u5F53\u524D\u89D2\u8272");
  if (url.pathname === root && request.method === "POST") {
    const target2 = await load(String(input.target_id || ""), charId);
    if (!target2) return fail("\u539F\u8BB0\u5FC6\u4E0D\u5B58\u5728\u6216\u5C5E\u4E8E\u5176\u4ED6\u89D2\u8272", 404);
    if (!input.base || input.base.content !== target2.content || stableJson(input.base.metadata || {}) !== stableJson(metadata(target2))) return fail("\u539F\u8BB0\u5FC6\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u751F\u6210\u4FEE\u6539\u63D0\u6848", 409);
    const sources = input.sources;
    if (!Array.isArray(sources) || !sources.length || sources.length > 6 || !sources.every((value) => value && ["user", "assistant"].includes(value.role) && typeof value.content === "string" && value.content.length <= 12e3)) return fail("\u672C\u6B21\u5BF9\u8BDD\u6765\u6E90\u65E0\u6548");
    let draft2;
    try {
      draft2 = validateChangeDraft(input, svc.publicMemory(target2), sources);
    } catch (error) {
      return fail(error.message);
    }
    const currentId = metadata(target2).current_reflection_id;
    const current = draft2.action === "revise_reflection" && typeof currentId === "string" ? await load(currentId, charId) : null;
    if (currentId && draft2.action === "revise_reflection" && (!current || !active(current) || metadata(current).kind !== "reflection" || metadata(current).event_id !== target2.memory_id)) return fail("\u5F53\u524D\u611F\u60F3\u5173\u8054\u65E0\u6548\uFF0C\u8BF7\u5148\u68C0\u67E5\u539F\u8BB0\u5FC6", 409);
    const prior = draft2.action === "correct_fact" ? target2 : current;
    if (prior && draft2.content === prior.content && (draft2.confidence === void 0 || draft2.confidence === metadata(prior).confidence) && (draft2.mood === void 0 || draft2.mood === prior.mood)) return fail("\u63D0\u6848\u6CA1\u6709\u5B9E\u8D28\u53D8\u5316");
    const before2 = { target: target2, current };
    const dedupe = await svc.hash("p_", stableJson([charId, versionFields.map((field) => target2[field] ?? null), current ? versionFields.map((field) => current[field] ?? null) : null, draft2.action, draft2.content, draft2.confidence, draft2.mood]));
    await env.DB.prepare("INSERT OR IGNORE INTO memory_change_proposals(id,char_id,target_id,action,before_json,draft_json,source_json,dedupe_key,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(), charId, target2.memory_id, draft2.action, JSON.stringify(before2), JSON.stringify(draft2), JSON.stringify(sources), dedupe, Date.now()).run();
    const saved = await env.DB.prepare("SELECT * FROM memory_change_proposals WHERE dedupe_key = ? AND char_id = ?").bind(dedupe, charId).first();
    return svc.json(publicProposal(saved), 201);
  }
  const decision = /^\/memory\/change-proposals\/([^/]+)\/(approve|reject)$/.exec(url.pathname);
  if (!decision || request.method !== "POST") return fail("Not found", 404);
  const proposal = await env.DB.prepare("SELECT * FROM memory_change_proposals WHERE id = ? AND char_id = ?").bind(decision[1], charId).first();
  if (!proposal) return fail("\u63D0\u6848\u4E0D\u5B58\u5728\u6216\u5C5E\u4E8E\u5176\u4ED6\u89D2\u8272", 404);
  if (decision[2] === "reject") {
    if (proposal.status === "approved") return fail("\u63D0\u6848\u5DF2\u7ECF\u786E\u8BA4\uFF0C\u4E0D\u80FD\u518D\u5FFD\u7565", 409);
    await env.DB.prepare("UPDATE memory_change_proposals SET status='rejected',resolved_at=? WHERE id=? AND char_id=? AND status='pending'").bind(Date.now(), proposal.id, charId).run();
    const resolved = await env.DB.prepare("SELECT status FROM memory_change_proposals WHERE id=? AND char_id=?").bind(proposal.id, charId).first();
    if (resolved?.status !== "rejected") return fail("\u63D0\u6848\u5DF2\u5728\u5176\u4ED6\u8BBE\u5907\u786E\u8BA4\uFF0C\u8BF7\u5237\u65B0\u67E5\u770B", 409);
    return svc.json({ status: "rejected" });
  }
  if (input.confirmed !== true) return fail("\u9700\u8981\u7528\u6237\u5728\u786E\u8BA4\u9875\u4E3B\u52A8\u786E\u8BA4");
  const approvedResult = async (saved) => {
    const ids = JSON.parse(saved.result_json || "[]");
    const rows = await Promise.all(ids.map((id) => load(id, charId)));
    return svc.json({ status: "approved", records: rows.filter((row) => !!row).map(svc.publicMemory) });
  };
  if (proposal.status === "approved") return approvedResult(proposal);
  if (proposal.status !== "pending") return fail("\u8FD9\u4E2A\u63D0\u6848\u5DF2\u88AB\u5FFD\u7565", 409);
  const before = JSON.parse(proposal.before_json);
  const draft = JSON.parse(proposal.draft_json);
  const target = await load(proposal.target_id, charId);
  const same = (a, b) => !!a && active(a) && versionFields.every((field) => (a[field] ?? null) === (b[field] ?? null));
  if (!same(target, before.target)) return fail("\u539F\u8BB0\u5FC6\u5DF2\u53D8\u5316\uFF0C\u65E7\u63D0\u6848\u4E0D\u80FD\u8986\u76D6\u65B0\u7248\u672C\u3002\u8BF7\u5FFD\u7565\u540E\u91CD\u65B0\u8BC4\u4F30", 409);
  if (before.current && !same(await load(before.current.memory_id, charId), before.current)) return fail("\u5F53\u524D\u611F\u60F3\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u8BC4\u4F30", 409);
  const suppliedVector = input.vector;
  if (!Array.isArray(suppliedVector) || suppliedVector.length !== Number(env.VECTOR_DIMENSIONS || 1024) || !suppliedVector.every((value) => typeof value === "number" && Number.isFinite(value)) || typeof input.model !== "string" || !input.model.trim()) return fail("\u786E\u8BA4\u4FEE\u6539\u9700\u8981\u6709\u6548\u7684\u65B0\u6B63\u6587\u5411\u91CF\u53CA\u6A21\u578B");
  const modelName = (value) => value.replace(/^Pro\//i, "").trim().toLowerCase();
  if (target.model && modelName(target.model) !== modelName(input.model)) return fail("Embedding \u6A21\u578B\u4E0E\u539F\u8BB0\u5FC6\u4E0D\u4E00\u81F4\uFF0C\u8BF7\u5148\u7EDF\u4E00\u6A21\u578B\u5E76\u91CD\u5EFA\u5411\u91CF");
  const now = Date.now();
  const targetMetadata = metadata(target);
  const revision = Number(targetMetadata.review_revision || 0) + 1;
  const newId = proposal.action === "correct_fact" ? target.memory_id : `reflection_${proposal.id}`;
  const newMetadata = proposal.action === "correct_fact" ? { ...targetMetadata, review_revision: revision, ...draft.confidence === void 0 ? {} : { confidence: draft.confidence } } : { ...before.current ? metadata(before.current) : {}, kind: "reflection", event_id: target.memory_id, status: "active", review_revision: revision, ...before.current ? { previous_id: before.current.memory_id } : {}, ...draft.confidence === void 0 ? {} : { confidence: draft.confidence } };
  const normalized = await svc.normalize({ ...svc.publicMemory(proposal.action === "correct_fact" ? target : before.current || target), memory_id: newId, char_id: charId, content: draft.content, metadata: newMetadata, vector: suppliedVector, model: input.model, dimensions: suppliedVector.length, archived: false, is_summary: false, event_box_id: proposal.action === "correct_fact" ? target.event_box_id : null, created_at: proposal.action === "correct_fact" ? target.created_at : now, last_accessed_at: proposal.action === "correct_fact" ? target.last_accessed_at : now, access_count: proposal.action === "correct_fact" ? target.access_count : 0, mood: proposal.action === "correct_fact" ? targetMetadata.kind === "event" ? "neutral" : target.mood : draft.mood || before.current?.mood || "neutral", pinned_until: proposal.action === "correct_fact" ? target.pinned_until : null }, suppliedVector.length);
  normalized.row.vector_key = await svc.hash("m_", `${newId}:${proposal.id}`);
  await env.VECTORS.upsert([{ id: normalized.row.vector_key, namespace: normalized.row.namespace_key, values: normalized.vector }]);
  const conditions = ["EXISTS(SELECT 1 FROM memory_change_proposals WHERE id=? AND char_id=? AND status='pending')"];
  const values = [proposal.id, charId];
  for (const row of [before.target, before.current].filter((row2) => !!row2)) {
    conditions.push(`EXISTS(SELECT 1 FROM memory_vectors WHERE ${versionFields.map((field) => `${String(field)} IS ?`).join(" AND ")})`);
    values.push(...versionFields.map((field) => row[field] ?? null));
  }
  const resultIds = [newId];
  const statements = [env.DB.prepare(`INSERT INTO memory_change_guards(proposal_id,valid) VALUES (?, CASE WHEN ${conditions.join(" AND ")} THEN 1 ELSE 0 END)`).bind(proposal.id, ...values), svc.bind(normalized.row)];
  if (proposal.action === "revise_reflection") {
    statements.push(env.DB.prepare("UPDATE memory_vectors SET metadata_json=? WHERE memory_id=? AND char_id=?").bind(JSON.stringify({ ...targetMetadata, review_revision: revision, current_reflection_id: newId }), target.memory_id, charId));
    resultIds.push(target.memory_id);
    if (before.current) {
      statements.push(env.DB.prepare("UPDATE memory_vectors SET metadata_json=?,archived=1 WHERE memory_id=? AND char_id=?").bind(JSON.stringify({ ...metadata(before.current), status: "superseded", review_revision: revision }), before.current.memory_id, charId));
      resultIds.push(before.current.memory_id);
    }
  }
  statements.push(env.DB.prepare("UPDATE memory_change_proposals SET status='approved',resolved_at=?,result_json=? WHERE id=? AND char_id=? AND status='pending'").bind(now, JSON.stringify(resultIds), proposal.id, charId), env.DB.prepare("DELETE FROM memory_change_guards WHERE proposal_id=?").bind(proposal.id));
  try {
    await env.DB.batch(statements);
  } catch (error) {
    const fresh = await env.DB.prepare("SELECT * FROM memory_change_proposals WHERE id=? AND char_id=?").bind(proposal.id, charId).first();
    if (fresh?.status === "approved") return approvedResult(fresh);
    if (error.message.includes("CHECK constraint")) return fail("\u539F\u8BB0\u5FC6\u5DF2\u53D8\u5316\uFF0C\u672A\u4FDD\u5B58\u4FEE\u6539\uFF0C\u8BF7\u91CD\u65B0\u8BC4\u4F30", 409);
    throw error;
  }
  return approvedResult({ ...proposal, result_json: JSON.stringify(resultIds) });
}

// worker/memory-sync/src/index.ts
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,apikey,Prefer",
  "Access-Control-Expose-Headers": "Content-Range",
  "Access-Control-Max-Age": "86400"
};
var json = (data, status = 200, extraHeaders = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extraHeaders }
});
var empty = (status = 204, extraHeaders = {}) => new Response(null, { status, headers: { ...CORS, ...extraHeaders } });
var schemaReady = /* @__PURE__ */ new WeakMap();
async function ensureSchema(db) {
  let pending = schemaReady.get(db);
  if (!pending) {
    pending = initializeSchema(db).catch((error) => {
      schemaReady.delete(db);
      throw error;
    });
    schemaReady.set(db, pending);
  }
  await pending;
}
async function initializeSchema(db) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS memory_vectors (
      memory_id TEXT PRIMARY KEY,
      vector_key TEXT NOT NULL UNIQUE,
      namespace_key TEXT NOT NULL,
      char_id TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      vector_json TEXT NOT NULL,
      dimensions INTEGER NOT NULL DEFAULT 1024,
      model TEXT,
      room TEXT,
      importance INTEGER NOT NULL DEFAULT 5,
      tags_json TEXT NOT NULL DEFAULT '[]',
      mood TEXT NOT NULL DEFAULT '',
      valence REAL,
      arousal REAL,
      created_at INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL DEFAULT 0,
      access_count INTEGER NOT NULL DEFAULT 0,
      pinned_until INTEGER,
      source_id TEXT,
      origin TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      is_summary INTEGER NOT NULL DEFAULT 0,
      event_box_id TEXT,
      metadata_json TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_memory_vectors_char ON memory_vectors(char_id)`,
    `CREATE INDEX IF NOT EXISTS idx_memory_vectors_room ON memory_vectors(char_id, room)`,
    `CREATE INDEX IF NOT EXISTS idx_memory_vectors_archived ON memory_vectors(char_id, archived)`,
    `CREATE INDEX IF NOT EXISTS idx_memory_vectors_event_box ON memory_vectors(event_box_id)`,
    `CREATE TABLE IF NOT EXISTS shared_recent_contexts (
      brain_id TEXT PRIMARY KEY,
      char_id TEXT NOT NULL DEFAULT '',
      messages_json TEXT NOT NULL DEFAULT '[]',
      source_device_id TEXT NOT NULL DEFAULT '',
      source_device_name TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    )`
  ];
  await db.batch(statements.map((statement) => db.prepare(statement)));
  const columns = await db.prepare("PRAGMA table_info(memory_vectors)").all();
  if (!columns.results.some((column) => column.name === "metadata_json")) {
    try {
      await db.prepare("ALTER TABLE memory_vectors ADD COLUMN metadata_json TEXT").run();
    } catch (error) {
      const current = await db.prepare("PRAGMA table_info(memory_vectors)").all();
      if (!current.results.some((column) => column.name === "metadata_json")) throw error;
    }
  }
  await db.batch([
    db.prepare("CREATE INDEX IF NOT EXISTS idx_memory_library_created ON memory_vectors(created_at DESC, memory_id DESC)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_memory_library_kind ON memory_vectors(json_extract(metadata_json, '$.kind'), created_at DESC, memory_id DESC)"),
    ...eventBoxRetirementSchema.map((statement) => db.prepare(statement)),
    ...memoryChangesSchema.map((statement) => db.prepare(statement))
  ]);
}
function authorized(request, env) {
  const expected = env.SYNC_TOKEN?.trim();
  if (!expected) return false;
  const auth = request.headers.get("Authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  return bearer === expected || request.headers.get("apikey")?.trim() === expected;
}
function preferRepresentation(request) {
  return (request.headers.get("Prefer") || "").toLowerCase().includes("return=representation");
}
function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function nullableNumber(value) {
  if (value === null || value === void 0 || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function boolInt(value) {
  return value === true || value === 1 || value === "true" ? 1 : 0;
}
function parseVectorInput(value) {
  let raw = value;
  if (typeof value === "string") {
    const clean = value.trim();
    try {
      raw = JSON.parse(clean.startsWith("[") ? clean : `[${clean}]`);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const vector = raw.map(Number);
  return vector.every(Number.isFinite) ? vector : null;
}
async function hashKey(prefix, value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}${hex.slice(0, 62)}`;
}
function safeJsonArray(value) {
  return Array.isArray(value) ? value : [];
}
var InputError = class extends Error {
};
var MemoryConflict = class extends Error {
};
function serializeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InputError("metadata \u5FC5\u987B\u662F JSON \u5BF9\u8C61\uFF1B\u6E05\u7A7A\u8BF7\u4F7F\u7528 {}");
  }
  const encoded = JSON.stringify(value);
  if (new TextEncoder().encode(encoded).length > 16384) throw new InputError("metadata \u4E0D\u80FD\u8D85\u8FC7 16 KiB");
  return encoded;
}
function memoryToPublic(row) {
  let tags = [];
  try {
    tags = safeJsonArray(JSON.parse(row.tags_json || "[]"));
  } catch {
    tags = [];
  }
  return {
    memory_id: row.memory_id,
    char_id: row.char_id,
    content: row.content,
    vector: row.vector_json,
    dimensions: row.dimensions,
    model: row.model,
    room: row.room,
    importance: row.importance,
    tags,
    mood: row.mood,
    valence: row.valence,
    arousal: row.arousal,
    created_at: row.created_at,
    last_accessed_at: row.last_accessed_at,
    access_count: row.access_count,
    pinned_until: row.pinned_until,
    source_id: row.source_id,
    origin: row.origin,
    archived: Boolean(row.archived),
    is_summary: Boolean(row.is_summary),
    event_box_id: row.event_box_id,
    metadata: JSON.parse(row.metadata_json || "{}")
  };
}
async function normalizeMemory(input, expectedDimensions) {
  const memoryId = String(input.memory_id || "").trim();
  const charId = String(input.char_id || "").trim();
  const vector = parseVectorInput(input.vector);
  if (!memoryId || !charId || !vector) throw new Error("memory_id\u3001char_id \u548C vector \u90FD\u662F\u5FC5\u586B\u9879");
  const dimensions = Math.trunc(numberValue(input.dimensions, vector.length));
  if (dimensions !== vector.length) throw new Error(`\u5411\u91CF\u957F\u5EA6 ${vector.length} \u4E0E dimensions ${dimensions} \u4E0D\u4E00\u81F4`);
  if (dimensions !== expectedDimensions) throw new Error(`\u6B64 Vectorize \u7D22\u5F15\u8981\u6C42 ${expectedDimensions} \u7EF4\u5411\u91CF\uFF0C\u6536\u5230 ${dimensions} \u7EF4`);
  const now = Date.now();
  const vectorKey = await hashKey("m_", memoryId);
  const namespaceKey = await hashKey("c_", charId);
  const row = {
    memory_id: memoryId,
    vector_key: vectorKey,
    namespace_key: namespaceKey,
    char_id: charId,
    content: String(input.content || ""),
    vector_json: JSON.stringify(vector),
    dimensions,
    model: input.model == null ? null : String(input.model),
    room: input.room == null ? null : String(input.room),
    importance: Math.trunc(numberValue(input.importance, 5)),
    tags_json: JSON.stringify(safeJsonArray(input.tags).map(String)),
    mood: String(input.mood || ""),
    valence: nullableNumber(input.valence),
    arousal: nullableNumber(input.arousal),
    created_at: Math.trunc(numberValue(input.created_at, now)),
    last_accessed_at: Math.trunc(numberValue(input.last_accessed_at, numberValue(input.created_at, now))),
    access_count: Math.trunc(numberValue(input.access_count, 0)),
    pinned_until: nullableNumber(input.pinned_until),
    source_id: input.source_id == null ? null : String(input.source_id),
    origin: input.origin == null ? null : String(input.origin),
    archived: boolInt(input.archived),
    is_summary: boolInt(input.is_summary),
    event_box_id: input.event_box_id == null ? null : String(input.event_box_id),
    metadata_json: input.metadata === void 0 ? null : serializeMetadata(input.metadata)
  };
  return { row, vector };
}
var UPSERT_BASE_SQL = `INSERT INTO memory_vectors (
  memory_id, vector_key, namespace_key, char_id, content, vector_json, dimensions, model, room,
  importance, tags_json, mood, valence, arousal, created_at, last_accessed_at, access_count,
  pinned_until, source_id, origin, archived, is_summary, event_box_id, metadata_json
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(memory_id) DO UPDATE SET
  vector_key=excluded.vector_key, namespace_key=excluded.namespace_key, char_id=excluded.char_id,
  content=excluded.content, vector_json=excluded.vector_json, dimensions=excluded.dimensions,
  model=excluded.model, room=excluded.room, importance=excluded.importance, tags_json=excluded.tags_json,
  mood=excluded.mood, valence=excluded.valence, arousal=excluded.arousal, created_at=excluded.created_at,
  last_accessed_at=excluded.last_accessed_at, access_count=excluded.access_count,
  pinned_until=excluded.pinned_until, source_id=excluded.source_id, origin=excluded.origin,
  archived=excluded.archived, is_summary=excluded.is_summary, event_box_id=excluded.event_box_id,
  metadata_json=COALESCE(excluded.metadata_json, memory_vectors.metadata_json)`;
var UPSERT_SQL = `${UPSERT_BASE_SQL}
WHERE COALESCE(json_extract(memory_vectors.metadata_json, '$.review_revision'),0)=0
  OR (excluded.char_id=memory_vectors.char_id AND excluded.content=memory_vectors.content
    AND excluded.archived=memory_vectors.archived AND excluded.is_summary=memory_vectors.is_summary
    AND (excluded.metadata_json IS NULL OR excluded.metadata_json=memory_vectors.metadata_json))`;
function bindMemory(db, row, confirmed = false) {
  return db.prepare(confirmed ? UPSERT_BASE_SQL : UPSERT_SQL).bind(
    row.memory_id,
    row.vector_key,
    row.namespace_key,
    row.char_id,
    row.content,
    row.vector_json,
    row.dimensions,
    row.model,
    row.room,
    row.importance,
    row.tags_json,
    row.mood,
    row.valence,
    row.arousal,
    row.created_at,
    row.last_accessed_at,
    row.access_count,
    row.pinned_until,
    row.source_id,
    row.origin,
    row.archived,
    row.is_summary,
    row.event_box_id,
    row.metadata_json
  );
}
async function upsertMemories(request, env) {
  const body = await request.json();
  const inputs = Array.isArray(body) ? body : [body];
  if (inputs.length === 0 || inputs.length > 100) return json({ error: "\u5355\u6B21\u9700\u8981\u4E0A\u4F20 1 \u5230 100 \u6761\u8BB0\u5FC6" }, 400);
  const expectedDimensions = Math.trunc(numberValue(env.VECTOR_DIMENSIONS, 1024));
  const normalized = await Promise.all(inputs.map((input) => normalizeMemory(input, expectedDimensions)));
  for (const { row } of normalized) {
    const current = await env.DB.prepare("SELECT * FROM memory_vectors WHERE memory_id=?").bind(row.memory_id).first();
    if (!current || !Number(JSON.parse(current.metadata_json || "{}").review_revision)) continue;
    if (row.char_id !== current.char_id || row.content !== current.content || row.archived !== current.archived || row.is_summary !== current.is_summary || row.metadata_json !== null && stableJson(JSON.parse(row.metadata_json)) !== stableJson(JSON.parse(current.metadata_json || "{}"))) throw new MemoryConflict("\u8FD9\u6761\u8BB0\u5FC6\u5DF2\u7ECF\u8FC7\u786E\u8BA4\u66F4\u65B0\uFF0C\u8BF7\u5237\u65B0\u5E76\u901A\u8FC7\u4FEE\u6539\u63D0\u6848\u66F4\u65B0\uFF0C\u65E7\u540C\u6B65\u4E0D\u80FD\u8986\u76D6\u5B83");
  }
  await env.DB.batch(normalized.map(({ row }) => bindMemory(env.DB, row)));
  await env.VECTORS.upsert(normalized.map(({ row, vector }) => ({ id: row.vector_key, values: vector, namespace: row.namespace_key })));
  if (!preferRepresentation(request)) return empty(204);
  const rows = await Promise.all(normalized.map(({ row }) => env.DB.prepare(
    "SELECT * FROM memory_vectors WHERE memory_id = ?"
  ).bind(row.memory_id).first()));
  return json(rows.filter((row) => row !== null).map(memoryToPublic), 201);
}
function memoryFilter(url) {
  const clauses = [];
  const values = [];
  const eventDate = url.searchParams.get("event_date");
  if (eventDate !== null) {
    if (!normalizeEventDate(eventDate) || !url.searchParams.get("char_id")?.startsWith("eq.")) throw new InputError("\u65E5\u671F\u67E5\u8BE2\u9700\u8981\u6709\u6548\u4E8B\u4EF6\u65E5\u671F\u548C\u89D2\u8272 ID");
    const expression = `CASE WHEN json_type(metadata_json, '$.event_date') IS NOT NULL THEN json_extract(metadata_json, '$.event_date') WHEN substr(content,1,1)='[' AND substr(content,instr(content,']')+1,1) IN (char(10),char(13)) THEN substr(content,2,instr(content,']')-2) END`;
    clauses.push(`(${expression} = ? OR ${expression} LIKE ?)`);
    values.push(eventDate, eventDate + "-%");
  }
  const keyword = url.searchParams.get("q")?.trim();
  if (keyword) {
    if (keyword.length > 200) throw new InputError("\u641C\u7D22\u5173\u952E\u8BCD\u4E0D\u80FD\u8D85\u8FC7 200 \u4E2A\u5B57\u7B26");
    const pattern = `%${keyword.replace(/[\\%_]/g, "\\$&")}%`;
    clauses.push(`(content LIKE ? ESCAPE '\\' OR memory_id LIKE ? ESCAPE '\\')`);
    values.push(pattern, pattern);
  }
  for (const [key, value] of url.searchParams) {
    if (!key.startsWith("metadata.")) continue;
    const field = key.slice("metadata.".length);
    if (!["kind", "event_id", "previous_id", "current_reflection_id", "status"].includes(field)) {
      throw new InputError(`\u4E0D\u652F\u6301\u7684 metadata \u7B5B\u9009\u5B57\u6BB5\uFF1A${field}`);
    }
    const expression = `json_extract(metadata_json, '$.${field}')`;
    if (value === "is.null") clauses.push(`${expression} IS NULL`);
    else if (value.startsWith("eq.")) {
      clauses.push(`${expression} = ?`);
      values.push(value.slice(3));
    } else throw new InputError("metadata \u7B5B\u9009\u53EA\u652F\u6301 eq. \u6216 is.null");
  }
  const charId = url.searchParams.get("char_id");
  if (charId?.startsWith("eq.")) {
    clauses.push("char_id = ?");
    values.push(charId.slice(3));
  }
  const room = url.searchParams.get("room");
  if (room?.startsWith("eq.")) {
    clauses.push("room = ?");
    values.push(room.slice(3));
  }
  const archived = url.searchParams.get("archived");
  if (archived?.startsWith("eq.")) {
    clauses.push("archived = ?");
    values.push(boolInt(archived.slice(3)));
  }
  const memoryId = url.searchParams.get("memory_id");
  if (memoryId?.startsWith("eq.")) {
    clauses.push("memory_id = ?");
    values.push(memoryId.slice(3));
  } else if (memoryId?.startsWith("in.(") && memoryId.endsWith(")")) {
    const ids = memoryId.slice(4, -1).split(",").map((id) => id.trim()).filter(Boolean).slice(0, 1e3);
    if (ids.length) {
      clauses.push(`memory_id IN (${ids.map(() => "?").join(",")})`);
      values.push(...ids);
    }
  } else if (memoryId?.startsWith("like.")) {
    const pattern = memoryId.slice(5).replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_").replace(/\*/g, "%");
    clauses.push(`memory_id LIKE ? ESCAPE '\\'`);
    values.push(pattern);
  }
  return { sql: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", values };
}
var SORT_FIELDS = /* @__PURE__ */ new Set(["memory_id", "char_id", "created_at", "last_accessed_at", "importance", "room"]);
function memoryOrder(url) {
  const terms = (url.searchParams.get("order") || "").split(",").flatMap((term) => {
    const [field, direction] = term.split(".");
    return SORT_FIELDS.has(field) ? [`${field} ${direction === "desc" ? "DESC" : "ASC"}`] : [];
  });
  return terms.length ? ` ORDER BY ${terms.join(", ")}` : "";
}
async function selectMemoryRows(db, url, withPaging = true) {
  const filter = memoryFilter(url);
  let query = `SELECT * FROM memory_vectors${filter.sql}${memoryOrder(url)}`;
  const values = [...filter.values];
  if (withPaging) {
    const limit = Math.min(1e3, Math.max(0, Math.trunc(numberValue(url.searchParams.get("limit") ?? 1e3, 1e3))));
    const offset = Math.max(0, Math.trunc(numberValue(url.searchParams.get("offset"), 0)));
    query += " LIMIT ? OFFSET ?";
    values.push(limit, offset);
  }
  return (await db.prepare(query).bind(...values).all()).results;
}
async function getMemories(request, env, url) {
  const filter = memoryFilter(url);
  const countRow = await env.DB.prepare(`SELECT COUNT(*) AS total FROM memory_vectors${filter.sql}`).bind(...filter.values).first();
  const total = Number(countRow?.total || 0);
  if (request.method === "HEAD") return empty(200, { "Content-Range": `0-0/${total}` });
  const rows = await selectMemoryRows(env.DB, url);
  const fields = url.searchParams.get("select");
  const selected = fields && fields !== "*" ? fields.split(",").map((field) => field.trim()) : null;
  const data = rows.map((row) => {
    const record = memoryToPublic(row);
    return selected ? Object.fromEntries(selected.filter((field) => Object.hasOwn(record, field)).map((field) => [field, record[field]])) : record;
  });
  const offset = Math.max(0, Math.trunc(numberValue(url.searchParams.get("offset"), 0)));
  return json(data, 200, { "Content-Range": rows.length ? `${offset}-${offset + rows.length - 1}/${total}` : `*/${total}` });
}
var PATCH_COLUMNS = {
  metadata: { column: "metadata_json", value: serializeMetadata },
  content: { column: "content", value: (value) => String(value || "") },
  room: { column: "room", value: (value) => value == null ? null : String(value) },
  importance: { column: "importance", value: (value) => Math.trunc(numberValue(value, 5)) },
  tags: { column: "tags_json", value: (value) => JSON.stringify(safeJsonArray(value).map(String)) },
  mood: { column: "mood", value: (value) => String(value || "") },
  valence: { column: "valence", value: nullableNumber },
  arousal: { column: "arousal", value: nullableNumber },
  last_accessed_at: { column: "last_accessed_at", value: (value) => Math.trunc(numberValue(value)) },
  access_count: { column: "access_count", value: (value) => Math.trunc(numberValue(value)) },
  pinned_until: { column: "pinned_until", value: nullableNumber },
  source_id: { column: "source_id", value: (value) => value == null ? null : String(value) },
  origin: { column: "origin", value: (value) => value == null ? null : String(value) },
  archived: { column: "archived", value: boolInt },
  is_summary: { column: "is_summary", value: boolInt },
  event_box_id: { column: "event_box_id", value: (value) => value == null ? null : String(value) }
};
async function patchMemories(request, env, url) {
  const payload = await request.json();
  const updates = Object.entries(payload).flatMap(([key, value]) => {
    const spec = PATCH_COLUMNS[key];
    return spec ? [{ column: spec.column, value: spec.value(value) }] : [];
  });
  if (!updates.length) return json({ error: "\u6CA1\u6709\u53EF\u66F4\u65B0\u7684\u5B57\u6BB5" }, 400);
  const filter = memoryFilter(url);
  if (!filter.sql) return json({ error: "PATCH \u5FC5\u987B\u5E26\u7B5B\u9009\u6761\u4EF6" }, 400);
  const protectedRows = await env.DB.prepare(`SELECT * FROM memory_vectors${filter.sql}`).bind(...filter.values).all();
  for (const current of protectedRows.results) {
    if (!Number(JSON.parse(current.metadata_json || "{}").review_revision)) continue;
    for (const field of ["content", "metadata", "archived", "is_summary"]) {
      if (!(field in payload)) continue;
      const original = field === "metadata" ? JSON.parse(current.metadata_json || "{}") : field === "archived" || field === "is_summary" ? Boolean(current[field]) : current[field];
      if (stableJson(payload[field]) !== stableJson(original)) throw new MemoryConflict("\u5DF2\u786E\u8BA4\u7684\u8BB0\u5FC6\u4E0D\u80FD\u88AB\u65E7\u540C\u6B65\u8986\u76D6\uFF0C\u8BF7\u901A\u8FC7\u4FEE\u6539\u63D0\u6848\u66F4\u65B0");
    }
  }
  const guarded = updates.filter(({ column }) => ["content", "metadata_json", "archived", "is_summary"].includes(column));
  const protection = guarded.length ? ` AND (COALESCE(json_extract(metadata_json, '$.review_revision'),0)=0 OR (${guarded.map(({ column }) => `${column} = ?`).join(" AND ")}))` : "";
  const sql = `UPDATE memory_vectors SET ${updates.map(({ column }) => `${column} = ?`).join(", ")}${filter.sql}${protection}`;
  await env.DB.prepare(sql).bind(...updates.map(({ value }) => value), ...filter.values, ...guarded.map(({ value }) => value)).run();
  if (!preferRepresentation(request)) return empty(204);
  const rows = await selectMemoryRows(env.DB, url, false);
  return json(rows.map(memoryToPublic));
}
async function deleteVectorKeys(index, keys) {
  for (let i = 0; i < keys.length; i += 1e3) await index.deleteByIds(keys.slice(i, i + 1e3));
}
async function deleteMemories(request, env, url) {
  const filter = memoryFilter(url);
  const explicitClearAll = url.searchParams.get("memory_id") === "not.is.null";
  if (!filter.sql && !explicitClearAll) return json({ error: "DELETE \u5FC5\u987B\u5E26\u7B5B\u9009\u6761\u4EF6" }, 400);
  const rows = await selectMemoryRows(env.DB, url, false);
  await deleteVectorKeys(env.VECTORS, rows.map((row) => row.vector_key));
  await env.DB.prepare(`DELETE FROM memory_vectors${filter.sql}`).bind(...filter.values).run();
  return preferRepresentation(request) ? json(rows.map(memoryToPublic)) : empty(204);
}
async function matchVectors(request, env) {
  const input = await request.json();
  const queryVector = parseVectorInput(input.query_embedding);
  const charId = String(input.match_char_id || "").trim();
  const dimensions = Math.trunc(numberValue(env.VECTOR_DIMENSIONS, 1024));
  if (!queryVector || !charId) return json({ error: "query_embedding \u548C match_char_id \u662F\u5FC5\u586B\u9879" }, 400);
  if (queryVector.length !== dimensions) return json({ error: `\u6B64 Vectorize \u7D22\u5F15\u8981\u6C42 ${dimensions} \u7EF4\u5411\u91CF` }, 400);
  const threshold = numberValue(input.match_threshold, 0.3);
  const count = Math.min(50, Math.max(1, Math.trunc(numberValue(input.match_count, 20))));
  const namespace = await hashKey("c_", charId);
  const candidateCount = Math.min(100, Math.max(count, count * 3));
  const result = await env.VECTORS.query(queryVector, { topK: candidateCount, namespace });
  const matches = (result.matches || []).filter((match) => numberValue(match.score) > threshold);
  if (!matches.length) return json([]);
  const keys = matches.map((match) => match.id);
  const rows = (await env.DB.prepare(`SELECT * FROM memory_vectors WHERE char_id = ? AND archived = 0 AND is_summary = 0 AND (json_extract(metadata_json,'$.status') IS NULL OR json_extract(metadata_json,'$.status')='active') AND vector_key IN (${keys.map(() => "?").join(",")})`).bind(charId, ...keys).all()).results;
  const byKey = new Map(rows.map((row) => [row.vector_key, row]));
  return json(matches.flatMap((match) => {
    const row = byKey.get(match.id);
    return row ? [{ ...memoryToPublic(row), similarity: numberValue(match.score) }] : [];
  }).slice(0, count));
}
function contextToPublic(row) {
  let messages = [];
  try {
    messages = safeJsonArray(JSON.parse(row.messages_json || "[]"));
  } catch {
    messages = [];
  }
  return { ...row, messages, messages_json: void 0 };
}
async function sharedContexts(request, env, url) {
  const brainFilter = url.searchParams.get("brain_id");
  const brainId = brainFilter?.startsWith("eq.") ? brainFilter.slice(3) : "primary";
  if (request.method === "GET" || request.method === "HEAD") {
    const row = await env.DB.prepare("SELECT * FROM shared_recent_contexts WHERE brain_id = ? LIMIT 1").bind(brainId).first();
    if (request.method === "HEAD") return empty(200, { "Content-Range": row ? "0-0/1" : "*/0" });
    return json(row ? [contextToPublic(row)] : []);
  }
  if (request.method === "POST") {
    const input = await request.json();
    const messages = safeJsonArray(input.messages).slice(-30);
    const row = {
      brain_id: String(input.brain_id || "primary"),
      char_id: String(input.char_id || ""),
      messages_json: JSON.stringify(messages),
      source_device_id: String(input.source_device_id || ""),
      source_device_name: String(input.source_device_name || ""),
      revision: Math.max(1, Math.trunc(numberValue(input.revision, 1))),
      updated_at: Math.trunc(numberValue(input.updated_at, Date.now()))
    };
    await env.DB.prepare(`INSERT INTO shared_recent_contexts (brain_id,char_id,messages_json,source_device_id,source_device_name,revision,updated_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(brain_id) DO UPDATE SET char_id=excluded.char_id,messages_json=excluded.messages_json,
      source_device_id=excluded.source_device_id,source_device_name=excluded.source_device_name,revision=excluded.revision,updated_at=excluded.updated_at`).bind(row.brain_id, row.char_id, row.messages_json, row.source_device_id, row.source_device_name, row.revision, row.updated_at).run();
    return preferRepresentation(request) ? json([contextToPublic(row)], 201) : empty(204);
  }
  if (request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM shared_recent_contexts WHERE brain_id = ?").bind(brainId).run();
    return empty(204);
  }
  return json({ error: "Method not allowed" }, 405);
}
var src_default = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return empty(204);
    if (!env.SYNC_TOKEN?.trim()) return json({ error: "Worker \u5C1A\u672A\u8BBE\u7F6E SYNC_TOKEN secret" }, 503);
    if (!authorized(request, env)) return json({ error: "\u8BA4\u8BC1\u5931\u8D25" }, 401);
    try {
      await ensureSchema(env.DB);
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      if (path.startsWith("/memory/change-proposals")) return await handleMemoryChanges(request, env, url, { publicMemory: memoryToPublic, normalize: normalizeMemory, bind: (row) => bindMemory(env.DB, row, true), hash: hashKey, json });
      if (path === "/health") return json({ ok: true, backend: "cloudflare-memory-sync", capabilities: ["memory_metadata_v1", "memory_library_search_v1", "event_box_retirement_v1", "confirmed_memory_changes_v1"] });
      if (path === "/memory/event-box-policy" && request.method === "GET") {
        const charId = url.searchParams.get("char_id")?.trim();
        if (!charId) throw new InputError("char_id \u662F\u5FC5\u586B\u9879");
        const policy = await env.DB.prepare("SELECT disabled FROM memory_event_box_policy WHERE char_id = ?").bind(charId).first();
        return json({ disabled: policy?.disabled === 1 });
      }
      if (path === "/rest/v1/rpc/match_vectors" && request.method === "POST") return await matchVectors(request, env);
      if (path === "/rest/v1/shared_recent_contexts") return await sharedContexts(request, env, url);
      if (path === "/rest/v1/memory_vectors") {
        if (request.method === "GET" || request.method === "HEAD") return await getMemories(request, env, url);
        if (request.method === "POST") return await upsertMemories(request, env);
        if (request.method === "PATCH") return await patchMemories(request, env, url);
        if (request.method === "DELETE") return await deleteMemories(request, env, url);
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: message }, error instanceof MemoryConflict ? 409 : error instanceof InputError || message.includes("\u5FC5\u586B") || message.includes("\u5411\u91CF") ? 400 : 500);
    }
  }
};
export {
  src_default as default,
  parseVectorInput
};
