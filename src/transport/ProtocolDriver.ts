/**
 * ProtocolDriver — the transport abstraction the engine depends on (Dependency Inversion). The engine's
 * trigger+capture loop talks to this interface, never to chrome-remote-interface directly; adding a new
 * debug protocol is a new implementation, not an engine change. Interface Segregation: just the few
 * operations the capture loop needs.
 */
export interface ProtocolDriver {
  /** Send a protocol request; resolves the result/response body. */
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  /** Subscribe to a protocol event. */
  on(event: string, cb: (params: any) => void): void;
  /** Tear down the connection. */
  close(): void;
}
