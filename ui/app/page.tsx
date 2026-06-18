"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearSessions,
  getSession,
  listSessions,
  streamUrl,
} from "@/lib/api";
import type {
  Lineage,
  Recording,
  SessionSummary,
  TraceEnvelope,
  TraceEvent,
} from "@/lib/types";

/* ---------- pure helpers (ported from ui.html) ---------- */

const fmt = (v: unknown): string =>
  typeof v === "object" && v !== null ? JSON.stringify(v) : String(v ?? "");

function ago(at: string | null): string {
  if (!at) return "";
  const s = Math.max(0, (Date.now() - new Date(at).getTime()) / 1000);
  if (s < 60) return Math.floor(s) + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  return Math.floor(s / 3600) + "h ago";
}

function SrcBadge({ source }: { source?: string | null }) {
  if (!source) return null;
  return <span className={`badge ${source}`}>{source}</span>;
}

function KvTable({ obj }: { obj?: Record<string, unknown> }) {
  const ks = Object.keys(obj ?? {});
  if (!ks.length) return null;
  return (
    <table className="kv">
      <tbody>
        {ks.map((k) => (
          <tr key={k}>
            <td className="k">{k}</td>
            <td className="v">{fmt(obj![k])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StackFrame({ frame }: { frame: string }) {
  const m = /^([^ (]+)/.exec(frame);
  if (!m) return <div>{frame}</div>;
  return (
    <div>
      <b>{m[1]}</b>
      {frame.slice(m[1].length)}
    </div>
  );
}

function Mutations({ lineage }: { lineage?: Lineage[] }) {
  if (!lineage || !lineage.length) return null;
  return (
    <div className="mutations">
      <h4>lineage · how values mutated across hits</h4>
      <div className="legend">
        <span className="li">
          <span className="sym expr">⊢</span> watched expression
        </span>
        <span className="li">
          <span className="sym local">•</span> local variable
        </span>
        <span className="sep" />
        <span className="li">
          <span className="sw val">9.99</span> initial / unchanged
        </span>
        <span className="li">
          <span className="sw chg">14.49</span> changed at this hit
        </span>
        <span className="li">
          <span className="sw last">16.49</span> final value
        </span>
        <span className="li">
          <span className="arr">→</span> mutation step
        </span>
      </div>
      {lineage.map((tr, ti) => {
        const steps = tr.series.filter((s, i) => s.changed || i === 0);
        const kind = tr.kind === "expr" ? "expr" : "local";
        return (
          <div className="mrow" key={ti}>
            <span
              className={`mname ${kind}`}
              title={kind === "expr" ? "watched expression" : "local variable"}
            >
              {kind === "expr" ? "⊢" : "•"} {tr.name}
            </span>
            <span className="mpath">
              {steps.map((s, i) => {
                const cls =
                  i === steps.length - 1 ? "last" : s.changed ? "chg" : "val";
                return (
                  <span key={i}>
                    {i > 0 && <span className="arr">→</span>}
                    <span className={cls}>{fmt(s.value)}</span>
                  </span>
                );
              })}
            </span>
            <span className="mcount">
              {tr.changes} change{tr.changes === 1 ? "" : "s"} · {tr.occurrences}{" "}
              hits
            </span>
          </div>
        );
      })}
    </div>
  );
}

function RecordingView({ rec }: { rec?: Recording }) {
  if (!rec) return null;
  if (rec.url) {
    const kb = rec.bytes ? ` · ${Math.round(rec.bytes / 1024)} KB` : "";
    return (
      <div className="recording">
        <h4>recording{kb}</h4>
        <video controls preload="metadata" src={rec.url} />
        <div className="rlink">
          <a href={rec.url} target="_blank" rel="noreferrer">
            {rec.url}
          </a>
        </div>
      </div>
    );
  }
  return (
    <div className="recording">
      <h4>recording (local)</h4>
      <div className="rlink">
        {rec.path}{" "}
        <span style={{ color: "var(--muted)" }}>
          — set S3_ENDPOINT to get a shareable link
        </span>
      </div>
    </div>
  );
}

function EventRow({
  e,
  open,
  onToggle,
}: {
  e: TraceEvent;
  open: boolean;
  onToggle: () => void;
}) {
  const a = e.attrs ?? {};
  const locStr = e.loc ? `${e.loc.file}:${e.loc.line ?? ""}` : "";
  const hasLocals = a.locals && Object.keys(a.locals).length > 0;
  const hasExprs = a.exprs && Object.keys(a.exprs).length > 0;
  const hasStack = a.stack && a.stack.length > 0;
  return (
    <div className={`evt${open ? " open" : ""}`}>
      <div className="head" onClick={onToggle}>
        <span className="seq">#{e.seq}</span>
        <span className="kind">{e.kind}</span>
        <span className="label">{e.label ?? ""}</span>
        <span className="loc">{locStr}</span>
        <span className="t">+{e.t}ms</span>
      </div>
      <div className="body">
        {hasLocals && (
          <div className="sec">
            <h4>locals</h4>
            <KvTable obj={a.locals} />
          </div>
        )}
        {hasExprs && (
          <div className="sec">
            <h4>watch</h4>
            <KvTable obj={a.exprs} />
          </div>
        )}
        {hasStack && (
          <div className="sec">
            <h4>stack</h4>
            <div className="stack">
              {a.stack!.map((f, i) => (
                <StackFrame key={i} frame={f} />
              ))}
            </div>
          </div>
        )}
        {!hasLocals && !hasExprs && !hasStack && (
          <span style={{ color: "var(--muted)" }}>no locals captured</span>
        )}
      </div>
    </div>
  );
}

/* ---------- page ---------- */

type LiveState = "connecting…" | "live" | "reconnecting…";

export default function Home() {
  const [sessions, setSessions] = useState<Record<string, SessionSummary>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<TraceEnvelope | null>(null);
  const [live, setLive] = useState<LiveState>("connecting…");
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [openEvents, setOpenEvents] = useState<Set<number>>(new Set([0]));

  // Latest `selected` for use inside the SSE handler without re-subscribing the stream.
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  // resetOpen=true only on an explicit click; the live SSE refresh of a running session keeps the user's
  // expanded events open instead of collapsing them back to [0] on every incoming hit.
  const loadDetail = useCallback(async (id: string, resetOpen = false) => {
    const env = await getSession(id).catch(() => null);
    setDetail(env);
    if (resetOpen) setOpenEvents(new Set([0]));
  }, []);

  const select = useCallback(
    (id: string) => {
      setSelected(id);
      void loadDetail(id, true);
    },
    [loadDetail],
  );

  // Boot (initial list) + live SSE stream. Runs once on mount (browser only).
  useEffect(() => {
    let cancelled = false;
    listSessions()
      .then((rows) => {
        if (cancelled) return;
        setSessions(Object.fromEntries(rows.map((s) => [s.sessionId!, s])));
      })
      .catch(() => {});

    const es = new EventSource(streamUrl());
    es.addEventListener("hello", () => setLive("live"));
    es.onmessage = (ev) => {
      const s: SessionSummary = JSON.parse(ev.data);
      setSessions((prev) => {
        const isNew = !(s.sessionId! in prev);
        if (isNew) {
          setFlash((f) => new Set(f).add(s.sessionId!));
          setTimeout(
            () =>
              setFlash((f) => {
                const n = new Set(f);
                n.delete(s.sessionId!);
                return n;
              }),
            1100,
          );
        }
        return { ...prev, [s.sessionId!]: s };
      });
      if (selectedRef.current === s.sessionId) void loadDetail(s.sessionId!);
    };
    es.onerror = () => setLive("reconnecting…");

    return () => {
      cancelled = true;
      es.close();
    };
  }, [loadDetail]);

  const onClear = useCallback(async () => {
    await clearSessions().catch(() => {});
    setSessions({});
    setSelected(null);
    setDetail(null);
  }, []);

  const rows = Object.values(sessions).sort((a, b) =>
    String(b.at ?? "").localeCompare(String(a.at ?? "")),
  );

  return (
    <>
      <header>
        <h1>trace</h1>
        <span className="sub">live execution traces</span>
        <span className="live">
          <span className={`dot${live === "live" ? " on" : ""}`} />
          <span>{live}</span>
        </span>
        <span className="spacer" />
        <span className="sub">
          {rows.length} session{rows.length === 1 ? "" : "s"}
        </span>
        <button onClick={onClear}>Clear</button>
      </header>
      <main>
        <div className="list">
          {rows.map((s) => (
            <div
              key={s.sessionId}
              className={`card${selected === s.sessionId ? " sel" : ""}${
                flash.has(s.sessionId!) ? " flash" : ""
              }`}
              onClick={() => select(s.sessionId!)}
            >
              <div className="cmd">{s.command || "?"}</div>
              <div className="row2">
                <span className={`status ${s.running ? "run" : s.ok === false ? "err" : "ok"}`} />
                <SrcBadge source={s.source} />
                {s.running && <span className="runlbl">running</span>}
                <span>{s.eventCount} ev</span>
                {s.durationMs != null && <span>· {s.durationMs}ms</span>}
                {s.errors > 0 && (
                  <span style={{ color: "var(--red)" }}>· {s.errors}✗</span>
                )}
                {s.warns > 0 && (
                  <span style={{ color: "var(--amber)" }}>· {s.warns}⚠</span>
                )}
                <span className="spacer" style={{ flex: 1 }} />
                <span>{ago(s.at)}</span>
              </div>
            </div>
          ))}
        </div>
        <div className="detail">
          {!detail ? (
            <div className="empty">
              Select a session, or run
              <br />
              <code>trace dynamic … --emit http://localhost:4000</code>
            </div>
          ) : (
            <Detail
              env={detail}
              openEvents={openEvents}
              onToggleEvent={(i) =>
                setOpenEvents((prev) => {
                  const n = new Set(prev);
                  if (n.has(i)) n.delete(i);
                  else n.add(i);
                  return n;
                })
              }
            />
          )}
        </div>
      </main>
    </>
  );
}

function Detail({
  env,
  openEvents,
  onToggleEvent,
}: {
  env: TraceEnvelope;
  openEvents: Set<number>;
  onToggleEvent: (i: number) => void;
}) {
  const d = env.data ?? {};
  const t = env.target ?? {};
  const m = env.meta ?? {};
  const events = d.events ?? [];
  return (
    <>
      <div className="dhead">
        <div className="cmd">
          {env.command} <SrcBadge source={t?.source} />
          {m.running && <span className="runlbl">running…</span>}
        </div>
        <div className="meta">
          <span>{m.at ?? ""}</span>
          {m.durationMs != null && <span>{m.durationMs}ms</span>}
          <span>{events.length} events</span>
          <span style={{ color: "var(--muted)" }}>{m.sessionId ?? ""}</span>
        </div>
        {t?.trigger && <div className="trigger">{t.trigger}</div>}
      </div>

      {(env.diagnostics ?? []).map((g, i) => (
        <div className={`diag ${g.level}`} key={i}>
          {g.message}
        </div>
      ))}

      <RecordingView rec={d.recording} />
      <Mutations lineage={d.lineage} />

      <div className="events">
        {events.length ? (
          events.map((e, i) => (
            <EventRow
              key={i}
              e={e}
              open={openEvents.has(i)}
              onToggle={() => onToggleEvent(i)}
            />
          ))
        ) : (
          <div className="empty">no events</div>
        )}
      </div>

      {d.response && (
        <div className="sec" style={{ padding: "0 20px" }}>
          <h4>response</h4>
          <pre className="resp">
            exit {d.response.exitCode} · {d.response.body || ""}
          </pre>
        </div>
      )}
      {d.console && d.console.length > 0 && (
        <div className="sec" style={{ padding: "0 20px" }}>
          <h4>console</h4>
          <pre className="resp">
            {d.console.map((c) => `[${c.type}] ${c.text}`).join("\n")}
          </pre>
        </div>
      )}
      {d.network && d.network.length > 0 && (
        <div className="sec" style={{ padding: "0 20px" }}>
          <h4>network (≥400)</h4>
          <pre className="resp">
            {d.network.map((n) => `${n.status} ${n.url}`).join("\n")}
          </pre>
        </div>
      )}
    </>
  );
}
