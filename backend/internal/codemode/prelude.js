// The script's world, set up before it runs: tools, ALL_TOOLS, text, console, exit, store and load, and nothing of
// the engine's own reach (files, timers, printing). __cm_host is the one way to the host; it is taken out of sight
// here and the functions below keep it. __cm_settle and __cm_finish stay for the host to call: a script that
// replaces them only confuses itself.
(() => {
  "use strict";
  const host = globalThis.__cm_host;
  const parse = JSON.parse, stringify = JSON.stringify, toText = String;
  const ErrorType = Error, TypeErrorType = TypeError, RangeErrorType = RangeError, PromiseType = Promise;
  const freeze = Object.freeze, isArray = Array.isArray;
  for (const name of ["__cm_host", "std", "os", "bjson", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
    "print", "scriptArgs", "navigator", "console", "gc", "performance", "QJS_PROXY_VALUE"]) {
    delete globalThis[name];
  }

  // A value as output: a string as it is, anything else as JSON, or as JavaScript prints it when JSON has no form
  // for it (undefined, a function).
  const show = (v) => {
    if (typeof v === "string") return v;
    const json = stringify(v);
    return json === undefined ? toText(v) : json;
  };

  const pending = new Map();
  const call = (name, args) => {
    let raw = "{}";
    if (args !== undefined && args !== null) {
      if (typeof args !== "object" || isArray(args)) throw new TypeErrorType("tools." + name + " takes one object of arguments");
      raw = stringify(args);
    }
    // made here, so a failed call points at the line of the script that made it
    const site = new ErrorType();
    return new PromiseType((resolve, reject) => {
      const id = host("call", name, raw);
      pending.set(id, { resolve, reject, site });
    });
  };
  globalThis.__cm_settle = (id) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    const r = parse(host("take", id));
    if (r.ok) {
      p.resolve(r.value);
      return;
    }
    p.site.message = r.error;
    p.reject(p.site);
  };

  const list = parse(host("tools"));
  const tools = {};
  for (const t of list) tools[t.name] = (args) => call(t.name, args);
  globalThis.tools = freeze(tools);
  globalThis.ALL_TOOLS = freeze(list.map((t) => freeze({ name: t.name, description: t.description })));

  globalThis.text = (value) => { host("text", show(value)); };
  const log = (...values) => { host("console", values.map(show).join(" ")); };
  globalThis.console = freeze({ log, info: log, warn: log, error: log, debug: log });

  const EXIT = freeze({});
  globalThis.exit = () => {
    host("exit");
    throw EXIT;
  };

  globalThis.store = (key, value) => {
    if (typeof key !== "string") throw new TypeErrorType("store takes a string key");
    let raw;
    if (value !== undefined) {
      raw = stringify(value);
      if (raw === undefined) throw new TypeErrorType("store takes a value JSON can write");
    }
    const refused = host("store", key, raw);
    if (refused) throw new RangeErrorType(refused);
  };
  globalThis.load = (key) => {
    if (typeof key !== "string") throw new TypeErrorType("load takes a string key");
    const raw = host("load", key);
    return raw === undefined ? undefined : parse(raw);
  };

  // How the script ended, once its body settled: what it returned, or what it threw, with where.
  globalThis.__cm_finish = (ok, v) => {
    if (v === EXIT) {
      host("return", undefined);
      return;
    }
    if (ok) {
      let shown;
      try {
        shown = v === undefined ? undefined : show(v);
      } catch (e) {
        ok = false;
        v = e;
      }
      if (ok) {
        host("return", shown);
        return;
      }
    }
    let message, stack = "";
    try {
      message = toText(v);
    } catch {
      message = "the script threw what cannot be shown";
    }
    try {
      if (v !== null && typeof v === "object" && typeof v.stack === "string") stack = v.stack;
    } catch {}
    host("error", message, stack);
  };
})();
