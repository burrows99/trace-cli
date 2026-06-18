/**
 * Target — what we attach to. An abstract entity with concrete subclasses (Open/Closed): adding a new
 * language target is a new subclass, not a change to existing code. Each knows its protocol (`source`) and
 * its trigger, and serializes to a TargetReference for the envelope (Liskov: all subclasses are substitutable).
 */
import { IsIn, IsOptional, IsString } from "class-validator";
import { DEFAULT_NODE_PORT, DEFAULT_CHROME_PORT } from "../shared/defaults.js";

export const TargetKind = { Node: "node", Chrome: "chrome" } as const;
export type TargetKind = (typeof TargetKind)[keyof typeof TargetKind];
export const PROTOCOL_KINDS = ["cdp"] as const;
export type ProtocolKind = (typeof PROTOCOL_KINDS)[number];

/** Human label for the inspector each target kind expects to be listening — used in connection errors. */
export const TARGET_LABEL: Record<TargetKind, string> = {
  node: "Node --inspect",
  chrome: "Chrome --remote-debugging-port",
};

/**
 * TargetReference — the serialized, validated shape of a Target on the envelope. A class (not a bare interface) so
 * `Trace.target` can be checked with @ValidateNested: `kind` must be a known target, `source` a known protocol,
 * `trigger` a string or null.
 */
export class TargetReference {
  @IsIn(Object.values(TargetKind)) kind: TargetKind;
  @IsIn(PROTOCOL_KINDS as unknown as string[]) source: ProtocolKind;
  @IsOptional() @IsString() trigger: string | null;

  constructor(init: Partial<TargetReference> = {}) {
    this.kind = init.kind ?? TargetKind.Node;
    this.source = init.source ?? "cdp";
    this.trigger = init.trigger ?? null;
  }
}

export abstract class Target {
  abstract readonly kind: TargetKind;
  abstract readonly source: ProtocolKind;
  abstract readonly port: number;
  abstract get trigger(): string | null;

  toReference(): TargetReference {
    return new TargetReference({ kind: this.kind, source: this.source, trigger: this.trigger });
  }
}

export class NodeTarget extends Target {
  override readonly kind = TargetKind.Node;
  override readonly source = "cdp" as const;
  constructor(
    override readonly port = DEFAULT_NODE_PORT,
    readonly curl?: string,
    readonly wsUrl?: string,
  ) { super(); }
  override get trigger(): string | null { return this.curl ?? null; }
}

export class ChromeTarget extends Target {
  override readonly kind = TargetKind.Chrome;
  override readonly source = "cdp" as const;
  constructor(
    override readonly port = DEFAULT_CHROME_PORT,
    readonly url?: string,
    readonly wsUrl?: string,
  ) { super(); }
  override get trigger(): string | null { return this.url ?? null; }
}
