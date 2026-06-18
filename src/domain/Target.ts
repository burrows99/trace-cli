/**
 * Target — what we attach to. An abstract entity with concrete subclasses (Open/Closed): adding a new
 * language target is a new subclass, not a change to existing code. Each knows its protocol (`source`) and
 * its trigger, and serializes to a TargetRef for the envelope (Liskov: all subclasses are substitutable).
 */
export type TargetKind = "node" | "chrome";
export type ProtocolKind = "cdp";

export interface TargetRef {
  kind: TargetKind;
  source: ProtocolKind;
  trigger: string | null;
}

export abstract class Target {
  abstract readonly kind: TargetKind;
  abstract readonly source: ProtocolKind;
  abstract readonly port: number;
  abstract get trigger(): string | null;

  toRef(): TargetRef {
    return { kind: this.kind, source: this.source, trigger: this.trigger };
  }
}

export class NodeTarget extends Target {
  override readonly kind = "node" as const;
  override readonly source = "cdp" as const;
  constructor(
    override readonly port = 9229,
    readonly curl?: string,
    readonly wsUrl?: string,
  ) { super(); }
  override get trigger(): string | null { return this.curl ?? null; }
}

export class ChromeTarget extends Target {
  override readonly kind = "chrome" as const;
  override readonly source = "cdp" as const;
  constructor(
    override readonly port = 9222,
    readonly url?: string,
    readonly wsUrl?: string,
  ) { super(); }
  override get trigger(): string | null { return this.url ?? null; }
}
