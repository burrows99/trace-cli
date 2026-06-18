import { CdpDriver } from "../transport/CdpDriver.js";
import { Cdp } from "../transport/cdp.js";
import { sleep } from "../shared/sleep.js";

// FIND_EL — the in-page selector resolver: `text=<substring>` matches the shortest visible interactive
// element whose text contains it; anything else is a raw CSS selector. Stringified to run inside the page.
const FIND_EL = `(sel)=>{
  const vis = e => e && e.offsetParent !== null && e.getClientRects().length;
  if (sel.startsWith('text=')) {
    const t = sel.slice(5).trim().toLowerCase();
    const els = [...document.querySelectorAll('button,a,[role=button],input[type=submit],[role=link],li,div,span')];
    const hit = els.filter(e => vis(e) && (e.innerText||e.textContent||'').trim().toLowerCase().includes(t))
                   .sort((a,b)=> (a.innerText||'').length - (b.innerText||'').length)[0];
    return hit || null;
  }
  return document.querySelector(sel);
}`;

/**
 * PageActions — the page-interaction layer for one CDP page target. Resolves a selector (CSS or `text=…`) and
 * performs trusted CDP input (real mouse/keyboard), so handlers gated on a user gesture — e.g. Pulse's
 * `window.open(deeplink, '_blank')` impersonation — actually fire. Pure DOM/input: no journey or tracing state.
 */
export class PageActions {
  constructor(private readonly driver: CdpDriver) {}

  /** Evaluate an expression in the page; throws on a thrown exception, returns the by-value result otherwise. */
  async eval(expr: string, awaitPromise = true): Promise<any> {
    const r = await this.driver.send(Cdp.Runtime.evaluate, { expression: expr, awaitPromise, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "evaluate failed");
    return r.result?.value;
  }

  /** A user `eval:` step — wrapped in an async IIFE so top-level `await` is legal; the result is awaited. */
  evalUser(js: string): Promise<any> {
    return this.eval(`(async()=>{ ${js} })()`, true);
  }

  /** The page's current location, or undefined if it can't be read. */
  currentUrl(): Promise<string | undefined> {
    return this.eval("location.href", false).catch(() => undefined);
  }

  /** Scroll the selector's element into view and return its viewport-center point, or null if not found. */
  async centerOf(sel: string): Promise<{ x: number; y: number } | null> {
    const js = `(()=>{const f=${FIND_EL};const el=f(${JSON.stringify(sel)});if(!el)return null;el.scrollIntoView({block:'center',inline:'center'});const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`;
    return this.eval(js, false);
  }

  /** Trusted left-click at the selector's center. Returns false if the selector resolves to nothing. */
  async click(sel: string): Promise<boolean> {
    const c = await this.centerOf(sel);
    if (!c) return false;
    await sleep(120); // let scrollIntoView settle before the click lands
    await this.#clickAt(c);
    return true;
  }

  /** Focus the selector (a click) then insert text. Returns false if the selector resolves to nothing. */
  async type(sel: string, text: string): Promise<boolean> {
    const c = await this.centerOf(sel);
    if (!c) return false;
    await this.#clickAt(c);
    await this.driver.send(Cdp.Input.insertText, { text });
    return true;
  }

  /** Poll until the selector resolves (element present) or the timeout elapses. */
  async waitFor(sel: string, timeoutMs = 12000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const js = `(()=>{const f=${FIND_EL};return !!f(${JSON.stringify(sel)});})()`;
    while (Date.now() < deadline) { if (await this.eval(js, false).catch(() => false)) return true; await sleep(200); }
    return false;
  }

  /** Navigate and wait for the load event (+ a settle beat for SPA hydration). */
  async navigate(url: string): Promise<void> {
    let loaded = false;
    this.driver.on(Cdp.Page.loadEventFired, () => { loaded = true; });
    await this.driver.send(Cdp.Page.navigate, { url });
    const deadline = Date.now() + 15000;
    while (!loaded && Date.now() < deadline) await sleep(100);
    await sleep(800); // settle render / SPA hydration
  }

  async #clickAt(c: { x: number; y: number }): Promise<void> {
    for (const type of ["mousePressed", "mouseReleased"] as const) {
      await this.driver.send(Cdp.Input.dispatchMouseEvent, { type, x: Math.round(c.x), y: Math.round(c.y), button: "left", buttons: 1, clickCount: 1 });
    }
  }
}
