// Copyright 2026 YourLocalGoober
//
// This file is part of GooberCord.
//
// GooberCord is free software: you can redistribute it and/or modify it
// under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the
// GNU Affero General Public License along with this program.  If not,
// see <https://www.gnu.org/licenses/>

// The XHR test bridge (wave-21). The client's transport is XMLHttpRequest
// now, and Node has no XMLHttpRequest — every fetch-stub test file seats this
// shim with ONE identical mount line:
//
//   import "./helpers/xhr-shim.mjs"; // lane-xhr wave-21: mounts globalThis.XMLHttpRequest (the transport bridge)
//
// THE BRIDGE LAW: nothing here captures fetch at mount time. The file's ONLY
// fetch reference is a single late-bound globalThis.fetch call at send time,
// so each test file's own fetch stub — set before, after, or swapped per
// test — keeps driving the client under the shim, byte-identical to the way
// it drove api()'s old send().
//
// The shim hands api() the raw shape it consumes (the status, the response
// text, the lenient header read) and keeps the JSON parse in the wrapper —
// the shim is transport, never policy. Stubs may return real Response
// objects or plain objects with async .text()/.json(): both are read
// leniently, and an accessor-less stub reads as an empty body.

const READY_STATES = { UNSENT: 0, OPENED: 1, HEADERS_RECEIVED: 2, DONE: 4 };

// The body read, lenient in the two shapes the suite's stubs carry: a real
// Response's .text() first, then a plain stub's .json(). The parsed
// text/string round-trips through the wrapper's own JSON.parse — the shim
// never parses policy, it only serializes what a json()-only stub carries.
const readBridgeBody = async (response) => {
  if (response == null) return "";
  if (typeof response.text === "function") {
    try {
      const text = await response.text();
      if (typeof text === "string") return text;
    } catch { /* fall through to the json arm */ }
  }
  if (typeof response.json === "function") {
    try {
      return JSON.stringify(await response.json());
    } catch { /* an empty body: the wrapper owns the parse refusal */ }
  }
  return "";
};

// The upload's deterministic size: a string body's length, a Blob/FormData
// size when the engine exposes one, zero otherwise (no body, no event bytes).
const uploadBodySize = (body) => {
  if (typeof body === "string") return body.length;
  if (body && typeof body.size === "number") return body.size;
  return 0;
};

class XMLHttpRequestBridge {
  constructor() {
    this.readyState = READY_STATES.UNSENT;
    this.status = 0;
    this.responseText = "";
    this.response = "";
    this.responseType = "";
    this.onprogress = null;
    this.onload = null;
    this.onerror = null;
    this.onabort = null;
    this.onloadend = null;
    this.upload = { onprogress: null };
    this._method = "";
    this._url = "";
    this._requestHeaders = {};
    this._body = undefined;
    this._responseHeaders = null;
    this._settled = false;
    // The shim owns the signal the underlying fetch rides: api()'s caller
    // signal is wired to abort(), and abort() cancels the in-flight read
    // through this controller (the cancel act's semantics ui/uploads.js
    // rides — an in-flight request can never settle after the abandon).
    this._abortController = new AbortController();
  }

  open(method, url, async = true) {
    this._method = method;
    this._url = url;
    this.readyState = READY_STATES.OPENED;
  }

  setRequestHeader(name, value) {
    this._requestHeaders[name] = value;
  }

  getResponseHeader(name) {
    const value = this._responseHeaders?.get?.(name);
    return value === undefined || value === null ? null : value;
  }

  // A cancel before send fires onabort immediately; a mid-flight cancel
  // aborts the underlying read. Either way the request never settles after
  // the abandon (the _settled guard silences the dead flight).
  abort() {
    if (this._settled) return;
    this._settled = true;
    this._abortController.abort();
    this._fire("onabort");
  }

  send(body) {
    this._body = body;
    this.readyState = READY_STATES.HEADERS_RECEIVED;
    void this._run();
  }

  async _run() {
    try {
      const response = await globalThis.fetch(this._url, {
        method: this._method,
        headers: { ...this._requestHeaders },
        credentials: "same-origin",
        signal: this._abortController.signal,
        body: this._body,
      });
      if (this._settled) return;
      this.status = typeof response?.status === "number" ? response.status : 0;
      this._responseHeaders = response?.headers ?? null;
      const text = await readBridgeBody(response);
      if (this._settled) return;
      this.responseText = text;
      this.response = this.responseType === "json" ? null : text;
      this.readyState = READY_STATES.DONE;
      const total = text.length;
      this.upload.onprogress?.({ loaded: uploadBodySize(this._body), total: uploadBodySize(this._body) });
      this.onprogress?.({ loaded: total, total });
      this._fire("onload");
    } catch (error) {
      if (this._settled) return;
      this._settled = true;
      // Network death keeps the status at 0 — the wrapper maps both arms
      // (onerror and a mid-flight abort) onto its own requestFailed copy,
      // verbatim; the shim invents no copy of its own.
      if (this._abortController.signal.aborted) this._fire("onabort");
      else this._fire("onerror");
    }
  }

  _fire(handlerName) {
    this[handlerName]?.();
  }
}

// Mount-on-import: the single identical line each fetch-stub test file
// carries. Always set (the same class), so a re-import is a no-op of value.
globalThis.XMLHttpRequest = XMLHttpRequestBridge;
