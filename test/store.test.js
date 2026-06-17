// SessionStore tests against the compiled build (dist/). Run via `npm test` (builds first).
// The Postgres integration test runs only when TEST_DATABASE_URL points at a throwaway database;
// otherwise it is skipped, so the suite stays green with no database present.
import { test } from "node:test";
import assert from "node:assert/strict";

import { PostgresSessionStore, createSessionStore } from "../dist/index.js";

const envelope = (sessionId) => ({
  tool: "trace",
  command: "dynamic.node",
  ok: true,
  meta: { sessionId, at: new Date().toISOString(), durationMs: 12 },
  target: { kind: "node", source: "app.js", trigger: "curl localhost" },
  data: { events: [{ source: "app.js" }, { source: "app.js" }] },
  diagnostics: [{ level: "warn" }, { level: "error" }],
});

test("createSessionStore builds Postgres from a URL, and fails fast without one", () => {
  const saved = { db: process.env.DATABASE_URL, pg: process.env.POSTGRES_URL };
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  try {
    const store = createSessionStore({ databaseUrl: "postgres://u:p@localhost:5432/db" });
    assert.ok(store instanceof PostgresSessionStore);

    // No connection string anywhere → hard error (database-driven, no file fallback).
    assert.throws(() => createSessionStore(), /DATABASE_URL/);

    // Env is honored too.
    process.env.DATABASE_URL = "postgres://u:p@localhost:5432/db";
    assert.ok(createSessionStore() instanceof PostgresSessionStore);
  } finally {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    if (saved.db !== undefined) process.env.DATABASE_URL = saved.db;
    if (saved.pg !== undefined) process.env.POSTGRES_URL = saved.pg;
  }
});

test("PostgresSessionStore rejects an unsafe table name", () => {
  assert.throws(() => new PostgresSessionStore("postgres://u:p@localhost:5432/db", "bad; drop table"), /invalid table name/);
});

test("PostgresSessionStore round-trip against a real database", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const store = new PostgresSessionStore(process.env.TEST_DATABASE_URL, "trace_sessions_test");
  try {
    await store.clear();
    assert.equal(await store.size(), 0);

    // An envelope with no sessionId is rejected and not persisted.
    assert.equal(await store.ingest({ tool: "trace", meta: {} }), null);
    assert.equal(await store.size(), 0);

    const s = await store.ingest(envelope("pg-1"));
    assert.equal(s.sessionId, "pg-1");
    assert.equal(await store.size(), 1);

    // Upsert: re-ingesting the same id keeps a single row.
    await store.ingest(envelope("pg-1"));
    assert.equal(await store.size(), 1);

    await store.ingest(envelope("pg-2"));
    const list = await store.list();
    assert.equal(list.length, 2);

    const got = await store.get("pg-1");
    assert.equal(got.meta.sessionId, "pg-1");
    assert.equal(got.data.events.length, 2);
    assert.equal(await store.get("nope"), null);

    await store.clear();
    assert.equal(await store.size(), 0);
  } finally {
    await store.close();
  }
});
