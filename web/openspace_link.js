// WebSocket link to OpenSpace's Server WebSocket interface (default port 4682).
// Speaks the same JSON envelope + apiHandshake v1.0.0 as TCP port 4681.

/**
 * Extract all finite numeric values from an OpenSpace script-engine payload
 * in Lua table key order (1..N before 10..NN). Booleans are ignored.
 */
export function allNumbers(obj, acc = []) {
  if (obj === null || obj === undefined || typeof obj === "boolean") {
    return acc;
  }
  if (typeof obj === "number") {
    if (Number.isFinite(obj)) acc.push(obj);
    return acc;
  }
  if (Array.isArray(obj)) {
    for (const v of obj) allNumbers(v, acc);
    return acc;
  }
  if (typeof obj === "object") {
    const keys = Object.keys(obj).sort((a, b) => {
      if (a.length !== b.length) return a.length - b.length;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    for (const k of keys) allNumbers(obj[k], acc);
  }
  return acc;
}

/**
 * Extract the first finite numeric value from an OpenSpace payload.
 */
export function firstNumber(obj) {
  if (obj === null || obj === undefined || typeof obj === "boolean") {
    return null;
  }
  if (typeof obj === "number") {
    return Number.isFinite(obj) ? obj : null;
  }
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const n = firstNumber(v);
      if (n !== null) return n;
    }
    return null;
  }
  if (typeof obj === "object") {
    const keys = Object.keys(obj).sort((a, b) => {
      if (a.length !== b.length) return a.length - b.length;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    for (const k of keys) {
      const n = firstNumber(obj[k]);
      if (n !== null) return n;
    }
  }
  return null;
}

function isLoopbackHost(host) {
  const h = String(host || "").trim().toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

export class OpenSpaceLink {
  /**
   * @param {object} [opts]
   * @param {(status: string) => void} [opts.onStatus]
   * @param {(level: string, msg: string) => void} [opts.onLog]
   * @param {typeof WebSocket} [opts.WebSocketImpl]
   */
  constructor(opts = {}) {
    this.onStatus = opts.onStatus || (() => {});
    this.onLog = opts.onLog || (() => {});
    this.WebSocketImpl = opts.WebSocketImpl || (typeof WebSocket !== "undefined" ? WebSocket : null);

    this.ws = null;
    this.dryRun = false;
    this.sent = 0;
    this._nextId = 1;
    this._pendingAsk = new Map(); // topic -> { resolve, timer, want }
    this._replyQueue = [];
    this.url = "";
  }

  get connected() {
    if (this.dryRun) return true;
    return this.ws !== null && this.ws.readyState === 1;
  }

  /**
   * Build ws:// or wss:// URL and warn on HTTPS -> non-loopback ws:// mixed content.
   */
  buildUrl(host = "localhost", port = 4682, useTls = false) {
    const raw = String(host || "localhost").trim();
    if (/^wss?:\/\//i.test(raw)) {
      return raw;
    }
    const proto = useTls ? "wss" : "ws";
    const cleanHost = raw.replace(/\/+$/, "");
    return `${proto}://${cleanHost}:${Number(port) || 4682}`;
  }

  connect(host = "localhost", port = 4682, { dryRun = false, useTls = false, timeoutSec = 5.0 } = {}) {
    this.close();
    this.dryRun = Boolean(dryRun);
    this.sent = 0;
    this._replyQueue = [];

    if (this.dryRun) {
      this.url = `dry-run://${host}:${port}`;
      this.onLog("info", "[DRY RUN] Connected in dry-run mode (Lua printed, nothing sent)");
      this.onStatus("dry-run");
      return Promise.resolve(true);
    }

    if (!this.WebSocketImpl) {
      const msg = "WebSocket is not available in this environment";
      this.onLog("error", msg);
      return Promise.reject(new Error(msg));
    }

    const url = this.buildUrl(host, port, useTls);
    this.url = url;

    if (
      typeof location !== "undefined" &&
      location.protocol === "https:" &&
      url.startsWith("ws://")
    ) {
      const bareHost = url.slice(5).split(":")[0];
      if (!isLoopbackHost(bareHost)) {
        this.onLog(
          "warn",
          `Mixed-content warning: HTTPS page connecting to non-loopback ${url} may be blocked by the browser. Serve locally over http:// or use wss://.`
        );
      }
    }

    this.onStatus("connecting");
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try {
        ws = new this.WebSocketImpl(url);
      } catch (err) {
        this.onStatus("disconnected");
        this.onLog("error", `Failed to open WebSocket (${url}): ${err.message || err}`);
        reject(err);
        return;
      }

      this.ws = ws;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.onLog("error", `Connection timed out waiting for ${url}`);
          this.close();
          reject(new Error("WebSocket connection timed out"));
        }
      }, timeoutSec * 1000);

      ws.onopen = () => {
        if (this.ws !== ws) return;
        // OpenSpace 0.22+ requires apiHandshake v1.0.0 before any topic messages.
        const ok = this._sendRaw({
          type: "apiHandshake",
          apiVersion: { major: 1, minor: 0, patch: 0 },
        });
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          if (ok) {
            this.onStatus("connected");
            this.onLog("info", `Connected to OpenSpace WebSocket at ${url}`);
            resolve(true);
          } else {
            this.close();
            reject(new Error("Failed to send apiHandshake"));
          }
        }
      };

      ws.onmessage = async (event) => {
        let text = event.data;
        if (typeof Blob !== "undefined" && text instanceof Blob) {
          text = await text.text();
        }
        if (typeof text !== "string") return;
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let msg;
          try {
            msg = JSON.parse(trimmed);
          } catch {
            continue;
          }
          this._handleMessage(msg);
        }
      };

      ws.onerror = () => {
        if (!settled) {
          clearTimeout(timer);
          settled = true;
          this.onStatus("disconnected");
          this.onLog("error", `Could not reach OpenSpace at ${url}`);
          if (this.ws === ws) this.ws = null;
          reject(new Error(`WebSocket error connecting to ${url}`));
        }
      };

      ws.onclose = () => {
        clearTimeout(timer);
        const wasCurrent = this.ws === ws;
        if (wasCurrent) {
          this.ws = null;
          this._flushPending(null);
          this.onStatus("disconnected");
          if (settled) {
            this.onLog("warn", "OpenSpace WebSocket closed");
          }
        }
        if (!settled) {
          settled = true;
          reject(new Error(`WebSocket closed before handshake (${url})`));
        }
      };
    });
  }

  close() {
    this.dryRun = false;
    this._flushPending(null);
    this._replyQueue = [];
    if (this.ws !== null) {
      const ws = this.ws;
      this.ws = null;
      try {
        ws.close();
      } catch {
        // ignore close errors
      }
      this.onStatus("disconnected");
    }
  }

  _flushPending(value) {
    for (const entry of this._pendingAsk.values()) {
      clearTimeout(entry.timer);
      entry.resolve(value);
    }
    this._pendingAsk.clear();
  }

  _handleMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    const topic = msg.topic;
    if (topic === undefined || topic === null) return;
    const payload = msg.payload;

    const pending = this._pendingAsk.get(topic);
    if (pending) {
      this._pendingAsk.delete(topic);
      clearTimeout(pending.timer);
      const val = pending.want > 1 ? allNumbers(payload) : firstNumber(payload);
      pending.resolve(val);
      return;
    }

    this._replyQueue.push([topic, payload]);
  }

  _sendRaw(msg) {
    const encoded = JSON.stringify(msg);
    if (this.dryRun) {
      this.sent += 1;
      return true;
    }
    if (!this.connected) return false;
    try {
      this.ws.send(encoded);
      this.sent += 1;
      return true;
    } catch {
      this.close();
      return false;
    }
  }

  /**
   * Fire-and-forget Lua script.
   */
  lua(script, synchronized = true) {
    return this._sendRaw({
      topic: this._nextId++,
      type: "luascript",
      payload: {
        script,
        return: false,
        shouldBeSynchronized: synchronized,
      },
    });
  }

  /**
   * Run Lua and await its numeric return value(s). Returns null on dryRun,
   * disconnect, or timeout.
   */
  ask(script, timeoutSec = 5.0, want = 1) {
    if (this.dryRun || !this.connected) {
      return Promise.resolve(null);
    }
    const topic = this._nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this._pendingAsk.has(topic)) {
          this._pendingAsk.delete(topic);
          resolve(null);
        }
      }, timeoutSec * 1000);

      this._pendingAsk.set(topic, { resolve, timer, want });
      const ok = this._sendRaw({
        topic,
        type: "luascript",
        payload: {
          script,
          return: true,
          shouldBeSynchronized: false,
        },
      });
      if (!ok) {
        this._pendingAsk.delete(topic);
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  /**
   * Fire off an async Lua query and return its topic id. Replies arrive via drain().
   */
  request(script) {
    if (this.dryRun || !this.connected) return null;
    const topic = this._nextId++;
    const ok = this._sendRaw({
      topic,
      type: "luascript",
      payload: {
        script,
        return: true,
        shouldBeSynchronized: false,
      },
    });
    return ok ? topic : null;
  }

  /**
   * Return and clear all buffered telemetry replies [[topic, payload], ...].
   */
  drain() {
    if (this._replyQueue.length === 0) return [];
    const out = this._replyQueue;
    this._replyQueue = [];
    return out;
  }
}
