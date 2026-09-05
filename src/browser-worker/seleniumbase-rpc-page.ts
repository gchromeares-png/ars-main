import { randomUUID } from "crypto";
import type { ChildProcessWithoutNullStreams } from "child_process";
import type { Frame, FrameLocator, Locator, Page, Response } from "patchright";

type NetworkEvent = { url?: string; headers?: Record<string, string>; body?: string };
type RpcReply = { type?: string; requestId?: string; ok?: boolean; result?: unknown; error?: string; url?: string; title?: string; events?: NetworkEvent[]; };
type Pending = { resolve: (value: RpcReply) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout; };
export interface LocatorDescriptor { selector: string; nth?: number; hasText?: { source: string; flags: string } | string; framePath?: string[]; }

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const serializePattern = (value: string | RegExp | undefined): string | { source: string; flags: string } | undefined => value instanceof RegExp ? { source: value.source, flags: value.flags } : value;
const serializeFunction = (fn: string | Function): string => typeof fn === "string" ? fn : fn.toString();
function roleSelector(role: string): string {
  switch (role.toLowerCase()) {
    case "button": return 'button,[role="button"],input[type="submit"],input[type="button"]';
    case "radio": return 'input[type="radio"],[role="radio"]';
    case "checkbox": return 'input[type="checkbox"],[role="checkbox"]';
    case "textbox": return 'input:not([type]),input[type="text"],input[type="email"],input[type="tel"],input[type="search"],input[type="url"],textarea,[role="textbox"]';
    case "link": return 'a,[role="link"]';
    default: return `[role="${role.replace(/"/g, "\\\"")}"]`;
  }
}

export class SeleniumBaseRpcTransport {
  private readonly pending = new Map<string, Pending>();
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private ended = false;
  private ready = false;
  private startInFlight = false;
  constructor(readonly child: ChildProcessWithoutNullStreams, private readonly prefix = "ARES_SB_TASK\t") {
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => this.consume(String(chunk)));
    child.stderr.on("data", chunk => { this.stderrBuffer = `${this.stderrBuffer}${String(chunk)}`.slice(-8_000); });
    child.once("exit", code => this.failAll(new Error(`SeleniumBase task worker exited (code=${String(code)}). ${this.stderrBuffer}`.trim())));
    child.once("error", error => this.failAll(error));
  }
  get closed(): boolean { return this.ended || this.child.exitCode != null; }
  get isReady(): boolean { return this.ready && !this.closed; }
  async start(payload: Record<string, unknown>, timeoutMs = 35_000): Promise<RpcReply> {
    if (this.ready) return { type: "ready", ok: true };
    if (this.startInFlight) throw new Error("SeleniumBase task worker start is already in progress.");
    this.startInFlight = true;
    try {
      const reply = await this.requestInternal("start", payload, timeoutMs, true);
      if (reply.type !== "ready" || reply.ok === false) throw new Error(reply.error || "SeleniumBase task worker did not report READY.");
      this.ready = true;
      return reply;
    } finally { this.startInFlight = false; }
  }
  async request(type: string, payload: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<RpcReply> {
    if (!this.isReady) throw new Error(`SeleniumBase RPC ${type} rejected before explicit READY.`);
    return this.requestInternal(type, payload, timeoutMs, false);
  }
  private async requestInternal(type: string, payload: Record<string, unknown>, timeoutMs: number, allowBeforeReady: boolean): Promise<RpcReply> {
    if (this.closed) throw new Error("SeleniumBase task worker is closed.");
    if (!allowBeforeReady && !this.ready) throw new Error(`SeleniumBase RPC ${type} rejected before READY.`);
    const requestId = randomUUID();
    const reply = new Promise<RpcReply>((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`SeleniumBase RPC ${type} timed out after ${timeoutMs}ms.`)); }, Math.max(250, timeoutMs));
      this.pending.set(requestId, { resolve, reject, timeout });
    });
    this.child.stdin.write(`${JSON.stringify({ type, requestId, ...payload })}\n`);
    return reply;
  }
  private consume(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/); this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith(this.prefix)) continue;
      let message: RpcReply; try { message = JSON.parse(line.slice(this.prefix.length)) as RpcReply; } catch { continue; }
      const id = message.requestId; if (!id) continue;
      const pending = this.pending.get(id); if (!pending) continue;
      this.pending.delete(id); clearTimeout(pending.timeout);
      if (message.type === "error" || message.ok === false) pending.reject(new Error(message.error || "SeleniumBase RPC failed.")); else pending.resolve(message);
    }
  }
  private failAll(error: Error): void {
    if (this.ended) return; this.ended = true; this.ready = false;
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(error); }
    this.pending.clear();
  }
}

class RpcResponse implements Response {
  constructor(private readonly event: NetworkEvent) {}
  url(): string { return String(this.event.url ?? ""); }
  headers(): Record<string, string> { return { ...(this.event.headers ?? {}) }; }
  async text(): Promise<string> { return String(this.event.body ?? ""); }
}

class SeleniumBaseRpcLocator implements Locator {
  [key: string]: any;
  constructor(private readonly page: SeleniumBaseRpcPage, private readonly descriptor: LocatorDescriptor) {}
  first(): Locator { return new SeleniumBaseRpcLocator(this.page, { ...this.descriptor, nth: 0 }); }
  nth(index: number): Locator { return new SeleniumBaseRpcLocator(this.page, { ...this.descriptor, nth: Math.max(0, Math.floor(index)) }); }
  filter(options: { hasText?: string | RegExp }): Locator { return new SeleniumBaseRpcLocator(this.page, { ...this.descriptor, hasText: serializePattern(options.hasText) }); }
  async count(): Promise<number> { const value = await this.op("count", {}, 5_000).catch(() => 0); return Number(value ?? 0) || 0; }
  async isVisible(options: { timeout?: number } = {}): Promise<boolean> { return Boolean(await this.op("is-visible", {}, options.timeout ?? 2_000).catch(() => false)); }
  async isEnabled(options: { timeout?: number } = {}): Promise<boolean> { return Boolean(await this.op("is-enabled", {}, options.timeout ?? 2_000).catch(() => false)); }
  async click(options: Record<string, unknown> = {}): Promise<void> { await this.op("click", { options }, Number(options["timeout"] ?? 15_000)); }
  async fill(value: string, options: Record<string, unknown> = {}): Promise<void> { await this.op("fill", { value, options }, Number(options["timeout"] ?? 15_000)); }
  async inputValue(): Promise<string> { return String(await this.op("input-value") ?? ""); }
  async innerText(options: { timeout?: number } = {}): Promise<string> { return String(await this.op("inner-text", {}, options.timeout ?? 5_000) ?? ""); }
  async allTextContents(): Promise<string[]> { const value = await this.op("all-text-contents"); return Array.isArray(value) ? value.map(item => String(item ?? "")) : []; }
  async selectOption(value: string): Promise<unknown> { return this.op("select-option", { value }); }
  async focus(): Promise<void> { await this.op("focus"); }
  async scrollIntoViewIfNeeded(): Promise<void> { await this.op("scroll-into-view"); }
  async waitFor(options: { state?: string; timeout?: number } = {}): Promise<void> { await this.op("wait-for", { state: options.state ?? "visible", timeoutMs: options.timeout }, options.timeout ?? 15_000); }
  async boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const value = await this.op("bounding-box").catch(() => null); if (!value || typeof value !== "object") return null;
    const box = value as Record<string, unknown>; return { x:Number(box["x"]??0), y:Number(box["y"]??0), width:Number(box["width"]??0), height:Number(box["height"]??0) };
  }
  async evaluate<T = unknown>(fn: ((element: Element, ...args: any[]) => T) | string, ...args: any[]): Promise<T> { return await this.op("evaluate-one", { script: serializeFunction(fn), args }) as T; }
  async evaluateAll<T = unknown>(fn: ((elements: Element[], ...args: any[]) => T) | string, ...args: any[]): Promise<T> { return await this.op("evaluate-all", { script: serializeFunction(fn), args }) as T; }
  private async op(action: string, extra: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<unknown> { return this.page.locatorOperation(action, this.descriptor, extra, timeoutMs); }
}

class SeleniumBaseRpcFrame implements Frame, FrameLocator {
  [key: string]: any;
  constructor(private readonly page: SeleniumBaseRpcPage, private readonly framePath: string[]) {}
  locator(selector: string): Locator { return new SeleniumBaseRpcLocator(this.page, { selector, framePath: [...this.framePath] }); }
  getByRole(role: string, options: { name?: string | RegExp } = {}): Locator { return new SeleniumBaseRpcLocator(this.page, { selector: roleSelector(role), framePath:[...this.framePath], hasText:serializePattern(options.name) }); }
}

export class SeleniumBaseRpcPage implements Page {
  [key: string]: any;
  private currentUrl = "about:blank";
  private readonly responseListeners = new Set<(response: Response) => void>();
  private responsePoll?: NodeJS.Timeout;
  readonly mouse = {
    move: async (x: number, y: number): Promise<void> => { await this.command("rpc", { action:"mouse-move", x, y }, 5_000); },
    click: async (x: number, y: number, options: Record<string, unknown> = {}): Promise<void> => { await this.command("rpc", { action:"mouse-click", x, y, options }, 10_000); }
  };
  constructor(private readonly transport: SeleniumBaseRpcTransport) { if (!transport.isReady) throw new Error("Cannot create SeleniumBase page before worker READY."); }
  locator(selector: string): Locator { return new SeleniumBaseRpcLocator(this, { selector }); }
  getByRole(role: string, options: { name?: string | RegExp } = {}): Locator { return new SeleniumBaseRpcLocator(this, { selector:roleSelector(role), hasText:serializePattern(options.name) }); }
  frameLocator(selector: string): FrameLocator { return new SeleniumBaseRpcFrame(this, [selector]); }
  frames(): Frame[] { const frames: Frame[] = [new SeleniumBaseRpcFrame(this, [])]; for (let i=1;i<=12;i++) frames.push(new SeleniumBaseRpcFrame(this,[`iframe:nth-of-type(${i})`])); return frames; }
  async goto(url: string, options: Record<string, unknown> = {}): Promise<unknown> { const reply=await this.command("navigate",{url,waitUntil:options["waitUntil"],timeoutMs:options["timeout"]},Number(options["timeout"]??30_000)+5_000); this.currentUrl=String(reply.url??url); return reply.result; }
  url(): string { return this.currentUrl; }
  async title(): Promise<string> { const reply=await this.command("rpc",{action:"title"},5_000); return String(reply.result??reply.title??""); }
  isClosed(): boolean { return this.transport.closed; }
  async evaluate<T = unknown>(fn: ((...args: any[]) => T) | string, ...args: any[]): Promise<T> { const reply=await this.command("rpc",{action:"evaluate-page",script:serializeFunction(fn),args},15_000); if(typeof reply.url==="string"&&reply.url)this.currentUrl=reply.url; return reply.result as T; }
  async waitForTimeout(ms: number): Promise<void> { await sleep(Math.max(0,ms)); }
  async waitForLoadState(state="domcontentloaded",options:{timeout?:number}={}):Promise<void>{await this.command("rpc",{action:"wait-load-state",state,timeoutMs:options.timeout},options.timeout??15_000);}
  async bringToFront():Promise<void>{await this.command("rpc",{action:"bring-to-front"},5_000);}
  on(event:"response",listener:(response:Response)=>void):Page{if(event!=="response")return this;this.responseListeners.add(listener);if(!this.responsePoll){this.responsePoll=setInterval(()=>void this.pollNetworkEvents(),500);this.responsePoll.unref?.();}return this;}
  off(event:"response",listener:(response:Response)=>void):Page{if(event!=="response")return this;this.responseListeners.delete(listener);if(!this.responseListeners.size&&this.responsePoll){clearInterval(this.responsePoll);this.responsePoll=undefined;}return this;}
  async locatorOperation(action:string,descriptor:LocatorDescriptor,extra:Record<string,unknown>={},timeoutMs=15_000):Promise<unknown>{const reply=await this.command("rpc",{action,locator:descriptor,...extra},timeoutMs);if(typeof reply.url==="string"&&reply.url)this.currentUrl=reply.url;return reply.result;}
  async closeTransport():Promise<void>{if(this.responsePoll)clearInterval(this.responsePoll);this.responsePoll=undefined;this.responseListeners.clear();if(!this.transport.closed&&this.transport.isReady)await this.transport.request("close",{},10_000).catch(()=>undefined);}
  private command(type:string,payload:Record<string,unknown>,timeoutMs:number):Promise<RpcReply>{return this.transport.request(type,payload,timeoutMs);}
  private async pollNetworkEvents():Promise<void>{if(!this.responseListeners.size||this.transport.closed||!this.transport.isReady)return;try{const reply=await this.command("network-events",{},4_000);for(const event of reply.events??[]){const response=new RpcResponse(event);for(const listener of this.responseListeners)listener(response);}if(typeof reply.url==="string"&&reply.url)this.currentUrl=reply.url;}catch{/* passive */}}
}
