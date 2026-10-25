var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
// ../../node_modules/.pnpm/@cloudflare+sandbox@1.0.3/node_modules/@cloudflare/sandbox/dist/index.mjs
import { DurableObject, WorkerEntrypoint, WorkerEntrypoint as WorkerEntrypoint2 } from "cloudflare:workers";

// ../../node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/util.js
function jsonStringifyReplacer(_, value) {
  if (typeof value === "bigint") return value.toString();
  return value;
}
__name(jsonStringifyReplacer, "jsonStringifyReplacer");
var Cached = class {
  static {
    __name(this, "Cached");
  }
  constructor(getter) {
    this._getter = getter;
    this._value = void 0;
  }
  get value() {
    const getter = this._getter;
    if (getter !== void 0) {
      this._value = getter();
      this._getter = void 0;
    }
    return this._value;
  }
};
function cached(getter) {
  return new Cached(getter);
}
__name(cached, "cached");
function nullish(input) {
  return input === null || input === void 0;
}
__name(nullish, "nullish");
function cleanRegex(source) {
  const start = source.startsWith("^") ? 1 : 0;
  const end = source.endsWith("$") ? source.length - 1 : source.length;
  return source.slice(start, end);
}
__name(cleanRegex, "cleanRegex");
var EVALUATING = /* @__PURE__ */ Symbol("evaluating");
function defineLazy(object2, key, getter) {
  let value = void 0;
  Object.defineProperty(object2, key, {
    get() {
      if (value === EVALUATING) {
        return void 0;
      }
      if (value === void 0) {
        value = EVALUATING;
        value = getter();
      }
      return value;
    },
    set(v) {
      Object.defineProperty(object2, key, {
        value: v,
        // configurable: true,
      });
    },
    configurable: true,
  });
}
__name(defineLazy, "defineLazy");
function assignProp(target, prop, value) {
  Object.defineProperty(target, prop, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
__name(assignProp, "assignProp");
function rawShape(def) {
  const desc = Object.getOwnPropertyDescriptor(def, "shape");
  return desc?.get ? desc.get.raw : desc?.value;
}
__name(rawShape, "rawShape");
var captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {};
function isObject(data) {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}
__name(isObject, "isObject");
function isPlainObject(o) {
  if (isObject(o) === false) return false;
  const ctor = o.constructor;
  if (ctor === void 0) return true;
  if (typeof ctor !== "function") return true;
  const prot = ctor.prototype;
  if (isObject(prot) === false) return false;
  if (Object.hasOwn(prot, "isPrototypeOf") === false) {
    return false;
  }
  return true;
}
__name(isPlainObject, "isPlainObject");
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
__name(escapeRegex, "escapeRegex");
function clone(inst, def, params) {
  const cl = new inst._zod.constr(def ?? inst._zod.def);
  if (!def || params?.parent) cl._zod.parent = inst;
  return cl;
}
__name(clone, "clone");
function normalizeParams(_params) {
  const params = _params;
  if (!params) return {};
  if (typeof params === "string") return { error: /* @__PURE__ */ __name(() => params, "error") };
  if (params?.message !== void 0) {
    if (params?.error !== void 0) throw new Error("Cannot specify both `message` and `error` params");
    params.error = params.message;
  }
  delete params.message;
  if (typeof params.error === "string")
    return { ...params, error: /* @__PURE__ */ __name(() => params.error, "error") };
  return params;
}
__name(normalizeParams, "normalizeParams");
function optionalKeys(shape) {
  return Object.keys(shape).filter((k) => {
    return shape[k]._zod.optin !== void 0 && shape[k]._zod.optout === "optional";
  });
}
__name(optionalKeys, "optionalKeys");
var NUMBER_FORMAT_RANGES = /* @__PURE__ */ (() => ({
  safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  int32: [-2147483648, 2147483647],
  uint32: [0, 4294967295],
  float32: [-34028234663852886e22, 34028234663852886e22],
  float64: [-Number.MAX_VALUE, Number.MAX_VALUE],
}))();
function aborted(x, startIndex = 0) {
  if (x.aborted === true) return true;
  for (let i = startIndex; i < x.issues.length; i++) {
    if (x.issues[i]?.continue !== true) {
      return true;
    }
  }
  return false;
}
__name(aborted, "aborted");
function explicitlyAborted(x, startIndex = 0) {
  if (x.aborted === true) return true;
  for (let i = startIndex; i < x.issues.length; i++) {
    if (x.issues[i]?.continue === false) {
      return true;
    }
  }
  return false;
}
__name(explicitlyAborted, "explicitlyAborted");
function prefixIssues(path, issues) {
  return issues.map((iss) => {
    var _a2;
    (_a2 = iss).path ?? (_a2.path = []);
    iss.path.unshift(path);
    return iss;
  });
}
__name(prefixIssues, "prefixIssues");
function unwrapMessage(message) {
  return typeof message === "string" ? message : message?.message;
}
__name(unwrapMessage, "unwrapMessage");
function sizeCaps(defChecks) {
  const caps = [];
  for (const ch of defChecks ?? []) {
    const d = ch._zod.def;
    if (!/_(length|size)$|_equals$/.test(d.check)) break;
    const max = d.maximum ?? d.length ?? d.size;
    if (max >= 0) caps.push([max, ch]);
  }
  return caps;
}
__name(sizeCaps, "sizeCaps");
function attachSchema(issues, start, inst) {
  var _a2;
  for (let i = start; i < issues.length; i++) {
    (_a2 = issues[i]).schema ?? (_a2.schema = inst);
  }
}
__name(attachSchema, "attachSchema");
function finalizeIssue(iss, ctx, config2) {
  var _a2;
  const traits = iss.inst?._zod?.traits;
  if (traits?.has("$ZodType")) {
    if (traits.has("$ZodCheck")) (_a2 = iss).schema ?? (_a2.schema = iss.inst);
    else iss.schema = iss.inst;
  }
  const schemaError = iss.schema !== iss.inst ? iss.schema?._zod.def?.error : void 0;
  const message = iss.message
    ? iss.message
    : (unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ??
      unwrapMessage(schemaError?.(iss)) ??
      unwrapMessage(ctx?.error?.(iss)) ??
      unwrapMessage(config2.customError?.(iss)) ??
      unwrapMessage(config2.localeError?.(iss)) ??
      "Invalid input");
  const full = {};
  for (const k of Object.keys(iss)) {
    if (k === "inst" || k === "schema" || k === "continue" || k === "input" || k === "__proto__") continue;
    full[k] = iss[k];
  }
  full.path ?? (full.path = []);
  full.message = message;
  if (ctx?.reportInput) {
    full.input = iss.input;
  }
  return full;
}
__name(finalizeIssue, "finalizeIssue");
var highSurrogate = /[\uD800-\uDBFF]/;
function codePointLength(str) {
  const units = str.length;
  if (!highSurrogate.test(str)) return units;
  let count = units;
  for (let i = 0; i < units - 1; i++) {
    if ((str.charCodeAt(i) & 64512) === 55296 && (str.charCodeAt(i + 1) & 64512) === 56320) {
      count--;
      i++;
    }
  }
  return count;
}
__name(codePointLength, "codePointLength");
function getLengthableOrigin(input) {
  if (Array.isArray(input)) return "array";
  if (typeof input === "string") return "string";
  return "unknown";
}
__name(getLengthableOrigin, "getLengthableOrigin");
function issue(...args) {
  const [iss, input, inst] = args;
  if (typeof iss === "string") {
    return {
      message: iss,
      code: "custom",
      input,
      inst,
    };
  }
  return { ...iss };
}
__name(issue, "issue");
function members(proto, table) {
  for (const key in table) {
    const desc = Object.getOwnPropertyDescriptor(table, key);
    if (desc.get) Object.defineProperty(proto, key, { ...desc, enumerable: false });
    else defineBound(proto, key, desc.value);
  }
}
__name(members, "members");
function own(inst, key, value, enumerable = true) {
  Object.defineProperty(inst, key, { configurable: true, writable: true, enumerable, value });
  return value;
}
__name(own, "own");
function hide(inst, key, value) {
  return own(inst, key, value, false);
}
__name(hide, "hide");
function defineBound(proto, key, fn) {
  Object.defineProperty(proto, key, {
    configurable: true,
    get() {
      return this == null ? fn : own(this, key, fn.bind(this));
    },
    set(value) {
      own(this, key, value);
    },
  });
}
__name(defineBound, "defineBound");
function claim(inst, sentinel) {
  const proto = Object.getPrototypeOf(inst);
  return sentinel in proto ? void 0 : proto;
}
__name(claim, "claim");
var installing;
var broke = false;
var breaker = {
  configurable: true,
  get() {
    broke = true;
    return void 0;
  },
};
function defineLazyInternal(inst, key, compute) {
  const proto = Object.getPrototypeOf(inst._zod);
  if (key in proto && installing !== inst._zod) {
    installing = void 0;
    return;
  }
  installing = inst._zod;
  Object.defineProperty(proto, key, {
    configurable: true,
    get() {
      Object.defineProperty(this, key, breaker);
      const outer = broke;
      broke = false;
      try {
        const value = compute(this);
        if (broke) delete this[key];
        else Object.defineProperty(this, key, { configurable: true, writable: true, value });
        broke = broke || outer;
        return value;
      } catch (err) {
        delete this[key];
        broke = broke || outer;
        throw err;
      }
    },
    set(value) {
      Object.defineProperty(this, key, { configurable: true, writable: true, value });
    },
  });
}
__name(defineLazyInternal, "defineLazyInternal");
function installLazyProp(inst, key, make, enumerable) {
  const proto = claim(inst, key);
  if (!proto) return;
  Object.defineProperty(proto, key, {
    configurable: true,
    get() {
      const desc = { configurable: true, writable: true, enumerable, value: void 0 };
      Object.defineProperty(this, key, desc);
      desc.value = make(this);
      Object.defineProperty(this, key, desc);
      return desc.value;
    },
    set(value) {
      Object.defineProperty(this, key, { configurable: true, writable: true, enumerable, value });
    },
  });
}
__name(installLazyProp, "installLazyProp");

// ../../node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/core.js
var _a;
var _zodDesc = { value: void 0, enumerable: false };
var _E = "captureStackTrace" in Error ? Error : null;
function newError(Definition) {
  const E = _E;
  if (E) {
    const saved = E.stackTraceLimit;
    if (typeof saved === "number") {
      try {
        E.stackTraceLimit = 0;
      } catch {
        _E = null;
        return new Definition();
      }
      try {
        return new Definition();
      } finally {
        E.stackTraceLimit = saved;
      }
    }
  }
  return new Definition();
}
__name(newError, "newError");
// @__NO_SIDE_EFFECTS__
function $constructor(name, initializer2, proto, params) {
  const zodProto = {};
  function Internals(def) {
    this.def = def;
    this.constr = _;
    this.traits = /* @__PURE__ */ new Set();
  }
  __name(Internals, "Internals");
  Internals.prototype = zodProto;
  const protoMembers = proto;
  const initialized = protoMembers && /* @__PURE__ */ new WeakSet();
  function init(inst, def) {
    if (!inst._zod) {
      _zodDesc.value = new Internals(def);
      try {
        Object.defineProperty(inst, "_zod", _zodDesc);
      } finally {
        _zodDesc.value = void 0;
      }
    } else if (inst._zod.traits.has(name)) {
      return;
    }
    inst._zod.traits.add(name);
    initializer2(inst, def);
    if (initialized) {
      const own2 = Object.getPrototypeOf(inst);
      const ctorProto = inst._zod.constr.prototype;
      let up = own2;
      while (up && up !== ctorProto) up = Object.getPrototypeOf(up);
      const target = up ?? own2;
      if (!initialized.has(target)) {
        initialized.add(target);
        members(target, protoMembers);
      }
    }
    const proto2 = _.prototype;
    for (const k in proto2) {
      if (!Object.hasOwn(proto2, k)) continue;
      if (!(k in inst)) {
        inst[k] = proto2[k].bind(inst);
      }
    }
  }
  __name(init, "init");
  const Parent = params?.Parent ?? Object;
  class Definition extends Parent {
    static {
      __name(this, "Definition");
    }
  }
  Object.defineProperty(Definition, "name", { value: name });
  function _(def) {
    const inst = params?.Parent ? newError(Definition) : this;
    init(inst, def);
    const deferred = inst._zod.deferred;
    if (deferred) {
      for (const fn of deferred) {
        fn();
      }
      inst._zod.deferred = void 0;
    }
    const pp = globalThis.__zod_globalConfig?.postProcessor;
    if (pp) pp(inst);
    return inst;
  }
  __name(_, "_");
  Object.defineProperty(_, "init", { value: init });
  Object.defineProperty(_, Symbol.hasInstance, {
    value: /* @__PURE__ */ __name((inst) => {
      if (params?.Parent && inst instanceof params.Parent) return true;
      return inst?._zod?.traits?.has(name);
    }, "value"),
  });
  Object.defineProperty(_, "name", { value: name });
  return _;
}
__name($constructor, "$constructor");
var $ZodAsyncError = class extends Error {
  static {
    __name(this, "$ZodAsyncError");
  }
  constructor() {
    super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
  }
};
(_a = globalThis).__zod_globalConfig ?? (_a.__zod_globalConfig = {});
var globalConfig = globalThis.__zod_globalConfig;
function config(newConfig) {
  if (newConfig) Object.assign(globalConfig, newConfig);
  return globalConfig;
}
__name(config, "config");

// ../../node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/errors.js
function _getMessage() {
  const internals = this._zod;
  internals.message ?? (internals.message = JSON.stringify(internals.def, jsonStringifyReplacer, 2));
  return internals.message;
}
__name(_getMessage, "_getMessage");
function _setMessage(value) {
  this._zod.message = value;
}
__name(_setMessage, "_setMessage");
var _messageDesc = {
  get: _getMessage,
  set: _setMessage,
  enumerable: true,
  configurable: true,
};
var _issuesDesc = { value: void 0, enumerable: false };
var _installedToString = /* @__PURE__ */ new WeakSet([Object.prototype, Error.prototype]);
var initializer = /* @__PURE__ */ __name((inst, def) => {
  inst.name = "$ZodError";
  _issuesDesc.value = def;
  Object.defineProperty(inst, "issues", _issuesDesc);
  _issuesDesc.value = void 0;
  Object.defineProperty(inst, "message", _messageDesc);
  const proto = Object.getPrototypeOf(inst);
  if (!_installedToString.has(proto)) {
    _installedToString.add(proto);
    Object.defineProperty(proto, "toString", {
      configurable: true,
      enumerable: false,
      get() {
        const value = /* @__PURE__ */ __name(() => this.message, "value");
        Object.defineProperty(this, "toString", { value, configurable: true, writable: true });
        return value;
      },
      set(value) {
        Object.defineProperty(this, "toString", { value, configurable: true, writable: true });
      },
    });
  }
}, "initializer");
var $ZodError = $constructor("$ZodError", initializer);
var $ZodRealError = $constructor("$ZodError", initializer, void 0, {
  Parent: Error,
});

// ../../node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/parse.js
var _parse = /* @__PURE__ */ __name((_Err) => {
  const fn = /* @__PURE__ */ __name((schema, value, _ctx, _params) => {
    const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
    const result = schema._zod.run({ value, issues: [] }, ctx);
    if (result instanceof Promise) {
      throw new $ZodAsyncError();
    }
    if (result.issues.length) {
      const e = new (_params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
      captureStackTrace(e, _params?.callee ?? fn);
      throw e;
    }
    return result.value;
  }, "fn");
  return fn;
}, "_parse");
var parse = /* @__PURE__ */ _parse($ZodRealError);
var _parseAsync = /* @__PURE__ */ __name((_Err) => {
  const fn = /* @__PURE__ */ __name(async (schema, value, _ctx, params) => {
    const ctx = _ctx ? { ..._ctx, async: true } : { async: true };
    let result = schema._zod.run({ value, issues: [] }, ctx);
    if (result instanceof Promise) result = await result;
    if (result.issues.length) {
      const e = new (params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
      captureStackTrace(e, params?.callee ?? fn);
      throw e;
    }
    return result.value;
  }, "fn");
  return fn;
}, "_parseAsync");
var parseAsync = /* @__PURE__ */ _parseAsync($ZodRealError);
var _safeParse = /* @__PURE__ */ __name(
  (_Err) => (schema, value, _ctx) => {
    const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
    const result = schema._zod.run({ value, issues: [] }, ctx);
    if (result instanceof Promise) {
      throw new $ZodAsyncError();
    }
    return result.issues.length ? failure(_Err, result.issues, ctx) : { success: true, data: result.value };
  },
  "_safeParse",
);
var safeParse = /* @__PURE__ */ _safeParse($ZodRealError);
function failure(Err, issues, ctx) {
  let error;
  return {
    success: false,
    get error() {
      if (!error) {
        error = new Err(issues.map((iss) => finalizeIssue(iss, ctx, config())));
        issues = void 0;
        ctx = void 0;
      }
      return error;
    },
    set error(e) {
      error = e;
      issues = void 0;
      ctx = void 0;
    },
  };
}
__name(failure, "failure");
var _safeParseAsync = /* @__PURE__ */ __name(
  (_Err) => async (schema, value, _ctx) => {
    const ctx = _ctx ? { ..._ctx, async: true } : { async: true };
    let result = schema._zod.run({ value, issues: [] }, ctx);
    if (result instanceof Promise) result = await result;
    return result.issues.length ? failure(_Err, result.issues, ctx) : { success: true, data: result.value };
  },
  "_safeParseAsync",
);
var safeParseAsync = /* @__PURE__ */ _safeParseAsync($ZodRealError);

// ../../node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/regexes.js
var anyString = /^[\s\S]{0,}$/;
var number = /^-?\d+(?:\.\d+)?$/;
var boolean = /^(?:true|false)$/i;
var _null = /^null$/i;

// ../../node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/checks.js
var $ZodCheck = /* @__PURE__ */ $constructor("$ZodCheck", (inst, def) => {
  var _a2;
  inst._zod ?? (inst._zod = {});
  inst._zod.def = def;
  (_a2 = inst._zod).onattach ?? (_a2.onattach = []);
});
var _whenHasLength = /* @__PURE__ */ __name((payload) => {
  const val = payload.value;
  return !nullish(val) && val.length !== void 0;
}, "_whenHasLength");
var numericOriginMap = {
  number: "number",
  bigint: "bigint",
  object: "date",
};
var $ZodCheckGreaterThan = /* @__PURE__ */ $constructor("$ZodCheckGreaterThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value >= def.value : payload.value > def.value) {
      return;
    }
    payload.issues.push({
      origin: numericOriginMap[typeof payload.value] ?? origin,
      code: "too_small",
      minimum: typeof def.value === "object" ? def.value.getTime() : def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort,
    });
  };
});
var $ZodCheckNumberFormat = /* @__PURE__ */ $constructor("$ZodCheckNumberFormat", (inst, def) => {
  $ZodCheck.init(inst, def);
  def.format = def.format || "float64";
  const isInt = def.format?.includes("int");
  const origin = isInt ? "int" : "number";
  const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
  inst._zod.check = (payload) => {
    const input = payload.value;
    if (isInt) {
      if (!Number.isInteger(input)) {
        payload.issues.push({
          expected: origin,
          format: def.format,
          code: "invalid_type",
          continue: false,
          input,
          inst,
        });
        return;
      }
      if (!Number.isSafeInteger(input)) {
        if (input > 0) {
          payload.issues.push({
            input,
            code: "too_big",
            maximum: Number.MAX_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            inclusive: true,
            continue: !def.abort,
          });
        } else {
          payload.issues.push({
            input,
            code: "too_small",
            minimum: Number.MIN_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            inclusive: true,
            continue: !def.abort,
          });
        }
        return;
      }
    }
    if (input < minimum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_small",
        minimum,
        inclusive: true,
        inst,
        continue: !def.abort,
      });
    }
    if (input > maximum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_big",
        maximum,
        inclusive: true,
        inst,
        continue: !def.abort,
      });
    }
  };
});
var $ZodCheckMinLength = /* @__PURE__ */ $constructor("$ZodCheckMinLength", (inst, def) => {
  var _a2;
  $ZodCheck.init(inst, def);
  (_a2 = inst._zod.def).when ?? (_a2.when = _whenHasLength);
  inst._zod.check = (payload) => {
    const input = payload.value;
    const units = input.length;
    const length =
      typeof input === "string" && units >= def.minimum && units < def.minimum * 2
        ? codePointLength(input)
        : units;
    if (length >= def.minimum) return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_small",
      minimum: def.minimum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort,
    });
  };
});
var $ZodCheckStringFormat = /* @__PURE__ */ $constructor("$ZodCheckStringFormat", (inst, def) => {
  var _a2, _b;
  $ZodCheck.init(inst, def);
  if (def.pattern)
    (_a2 = inst._zod).check ??
      (_a2.check = (payload) => {
        def.pattern.lastIndex = 0;
        if (def.pattern.test(payload.value)) return;
        payload.issues.push({
          origin: "string",
          code: "invalid_format",
          format: def.format,
          input: payload.value,
          ...(def.pattern ? { pattern: def.pattern.toString() } : {}),
          inst,
          continue: !def.abort,
        });
      });
  else (_b = inst._zod).check ?? (_b.check = () => {});
});
var $ZodCheckRegex = /* @__PURE__ */ $constructor("$ZodCheckRegex", (inst, def) => {
  $ZodCheckStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    def.pattern.lastIndex = 0;
    if (def.pattern.test(payload.value)) return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "regex",
      input: payload.value,
      pattern: def.pattern.toString(),
      inst,
      continue: !def.abort,
    });
  };
});
var $ZodCheckStartsWith = /* @__PURE__ */ $constructor("$ZodCheckStartsWith", (inst, def) => {
  $ZodCheck.init(inst, def);
  const pattern = new RegExp(`^${escapeRegex(def.prefix)}.*`);
  def.pattern ?? (def.pattern = pattern);
  inst._zod.check = (payload) => {
    if (payload.value.startsWith(def.prefix)) return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "starts_with",
      prefix: def.prefix,
      input: payload.value,
      inst,
      continue: !def.abort,
    });
  };
});

// ../../node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/versions.js
var version = {
  major: 4,
  minor: 6,
  patch: 7,
};

// ../../node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/schemas.js
var $ZodType = /* @__PURE__ */ $constructor(
  "$ZodType",
  (inst, def) => {
    var _a2;
    inst ?? (inst = {});
    inst._zod.def = def;
    inst._zod.bag = inst._zod.bag || {};
    inst._zod.version = version;
    const defChecks = inst._zod.def.checks;
    const checks = inst._zod.traits.has("$ZodCheck")
      ? [inst, ...(defChecks ?? [])]
      : defChecks?.length
        ? [...defChecks]
        : [];
    for (const ch of checks) {
      for (const fn of ch._zod.onattach) {
        fn(inst);
      }
    }
    if (checks.length === 0) {
      (_a2 = inst._zod).deferred ?? (_a2.deferred = []);
      inst._zod.deferred?.push(() => {
        inst._zod.run = inst._zod.parse;
      });
    } else {
      const runChecks = /* @__PURE__ */ __name((payload, checks2, ctx) => {
        if (payload.memo) return payload;
        let isAborted = aborted(payload);
        let asyncResult;
        for (const ch of checks2) {
          if (ch._zod.def.when) {
            if (explicitlyAborted(payload)) continue;
            const shouldRun = ch._zod.def.when(payload);
            if (!shouldRun) continue;
          } else if (isAborted) {
            continue;
          }
          const currLen = payload.issues.length;
          const _ = ch._zod.check(payload);
          if (_ instanceof Promise && ctx?.async === false) {
            throw new $ZodAsyncError();
          }
          if (asyncResult || _ instanceof Promise) {
            asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
              await _;
              const nextLen = payload.issues.length;
              if (nextLen === currLen) return;
              attachSchema(payload.issues, currLen, inst);
              if (!isAborted) isAborted = aborted(payload, currLen);
            });
          } else {
            const nextLen = payload.issues.length;
            if (nextLen === currLen) continue;
            attachSchema(payload.issues, currLen, inst);
            if (!isAborted) isAborted = aborted(payload, currLen);
          }
        }
        if (asyncResult) {
          return asyncResult.then(() => {
            return payload;
          });
        }
        return payload;
      }, "runChecks");
      const handleCanaryResult = /* @__PURE__ */ __name((canary, payload, ctx) => {
        if (aborted(canary)) {
          canary.aborted = true;
          return canary;
        }
        const checkResult = runChecks(payload, checks, ctx);
        if (checkResult instanceof Promise) {
          if (ctx.async === false) throw new $ZodAsyncError();
          return checkResult.then((checkResult2) => inst._zod.parse(checkResult2, ctx));
        }
        return inst._zod.parse(checkResult, ctx);
      }, "handleCanaryResult");
      inst._zod.run = (payload, ctx) => {
        if (ctx.skipChecks) {
          return inst._zod.parse(payload, ctx);
        }
        if (ctx.direction === "backward") {
          const canary = inst._zod.parse({ value: payload.value, issues: [] }, { ...ctx, skipChecks: true });
          if (canary instanceof Promise) {
            return canary.then((canary2) => {
              return handleCanaryResult(canary2, payload, ctx);
            });
          }
          return handleCanaryResult(canary, payload, ctx);
        }
        const result = inst._zod.parse(payload, ctx);
        if (result instanceof Promise) {
          if (ctx.async === false) throw new $ZodAsyncError();
          return result.then((result2) => runChecks(result2, checks, ctx));
        }
        return runChecks(result, checks, ctx);
      };
    }
  },
  {
    // Wrappers extend this by installing a richer factory over it; reading it eagerly would defeat the laziness.
    get "~standard"() {
      return hide(this, "~standard", standardProps(this));
    },
    set "~standard"(value) {
      own(this, "~standard", value);
    },
  },
);
var toStandardResult = /* @__PURE__ */ __name(
  (r, ctx) =>
    r.issues.length
      ? { issues: r.issues.map((iss) => finalizeIssue(iss, ctx, config())) }
      : { value: r.value },
  "toStandardResult",
);
async function validateAsync(inst, value) {
  const ctx = { async: true };
  return toStandardResult(await inst._zod.run({ value, issues: [] }, ctx), ctx);
}
__name(validateAsync, "validateAsync");
function standardProps(inst) {
  return {
    validate: /* @__PURE__ */ __name((value) => {
      const ctx = { async: false };
      try {
        const r = inst._zod.run({ value, issues: [] }, ctx);
        if (!(r instanceof Promise)) return toStandardResult(r, ctx);
      } catch (_) {}
      return validateAsync(inst, value);
    }, "validate"),
    vendor: "zod",
    version: 1,
  };
}
__name(standardProps, "standardProps");
var $ZodString = /* @__PURE__ */ $constructor("$ZodString", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = def.pattern ?? anyString;
  inst._zod.parse = (payload, _) => {
    if (def.coerce)
      try {
        payload.value = String(payload.value);
      } catch (_2) {}
    if (typeof payload.value === "string") return payload;
    payload.issues.push({
      expected: "string",
      code: "invalid_type",
      input: payload.value,
      inst,
    });
    return payload;
  };
});
var $ZodNumber = /* @__PURE__ */ $constructor("$ZodNumber", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = number;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Number(payload.value);
      } catch (_) {}
    const input = payload.value;
    if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) {
      return payload;
    }
    const received =
      typeof input === "number"
        ? Number.isNaN(input)
          ? "NaN"
          : !Number.isFinite(input)
            ? String(input)
            : void 0
        : void 0;
    payload.issues.push({
      expected: "number",
      code: "invalid_type",
      input,
      inst,
      ...(received ? { received } : {}),
    });
    return payload;
  };
});
var $ZodNumberFormat = /* @__PURE__ */ $constructor("$ZodNumberFormat", (inst, def) => {
  $ZodCheckNumberFormat.init(inst, def);
  $ZodNumber.init(inst, def);
});
var $ZodBoolean = /* @__PURE__ */ $constructor("$ZodBoolean", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = boolean;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Boolean(payload.value);
      } catch (_) {}
    const input = payload.value;
    if (typeof input === "boolean") return payload;
    payload.issues.push({
      expected: "boolean",
      code: "invalid_type",
      input,
      inst,
    });
    return payload;
  };
});
var $ZodNull = /* @__PURE__ */ $constructor("$ZodNull", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = _null;
  inst._zod.values = /* @__PURE__ */ new Set([null]);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (input === null) return payload;
    payload.issues.push({
      expected: "null",
      code: "invalid_type",
      input,
      inst,
    });
    return payload;
  };
});
var $ZodUnknown = /* @__PURE__ */ $constructor("$ZodUnknown", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload) => payload;
});
var $ZodNever = /* @__PURE__ */ $constructor("$ZodNever", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    payload.issues.push({
      expected: "never",
      code: "invalid_type",
      input: payload.value,
      inst,
    });
    return payload;
  };
});
function capSize(inst, size) {
  const caps = sizeCaps(inst._zod.def.checks);
  if (!caps.length) return;
  const cap = Math.min(...caps.map((c) => c[0]));
  const parse2 = inst._zod.parse;
  inst._zod.parse = (payload, ctx) => {
    const n = size(payload.value);
    if (n > cap && !ctx?.skipChecks && ctx?.direction !== "backward") {
      for (const [max, ch] of sizeCaps(inst._zod.def.checks)) {
        if (n > max && ch._zod.def.when(payload)) {
          const start = payload.issues.length;
          ch._zod.check(payload);
          payload.issues[start].continue = false;
          attachSchema(payload.issues, start, inst);
          return payload;
        }
      }
    }
    return parse2(payload, ctx);
  };
}
__name(capSize, "capSize");
var arraySize = /* @__PURE__ */ __name((input) => (Array.isArray(input) ? input.length : -1), "arraySize");
function handleArrayResult(result, final, index) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(index, result.issues));
  }
  final.value[index] = result.value;
}
__name(handleArrayResult, "handleArrayResult");
var $ZodArray = /* @__PURE__ */ $constructor("$ZodArray", (inst, def) => {
  $ZodType.init(inst, def);
  const memo = globalConfig.memoizer;
  memo?.attach(inst);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!Array.isArray(input)) {
      payload.issues.push({
        expected: "array",
        code: "invalid_type",
        input,
        inst,
      });
      return payload;
    }
    payload.value = memo ? memo.alloc(inst, payload, Array(input.length), ctx) : Array(input.length);
    const proms = [];
    const abortEarly = ctx?.abortEarly;
    for (let i = 0; i < input.length; i++) {
      const item = input[i];
      const result = def.element._zod.run(
        {
          value: item,
          issues: [],
        },
        ctx,
      );
      if (result instanceof Promise) {
        proms.push(result.then((result2) => handleArrayResult(result2, payload, i)));
      } else {
        handleArrayResult(result, payload, i);
        if (abortEarly && result.issues.length !== 0 && aborted(result)) break;
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
  capSize(inst, arraySize);
});
function handlePropertyResult(result, final, key, input, optin, optout) {
  const isPresent = key in input;
  const isOptionalOut = optout === "optional";
  if (!isPresent && isOptionalOut && optin === "optional") {
    return;
  }
  if (result.issues.length) {
    if (optin !== void 0 && isOptionalOut && !isPresent) {
      return;
    }
    final.issues.push(...prefixIssues(key, result.issues));
  }
  if (!isPresent && optin === void 0) {
    if (!result.issues.length) {
      final.issues.push({
        code: "invalid_type",
        expected: "nonoptional",
        input: void 0,
        path: [key],
      });
    }
    return;
  }
  if (result.value === void 0) {
    if (isPresent || (optin === "defaulted" && !isOptionalOut)) {
      final.value[key] = void 0;
    }
  } else {
    final.value[key] = result.value;
  }
}
__name(handlePropertyResult, "handlePropertyResult");
var NO_SYMBOL_KEYS = [];
function normalizeDef(def) {
  const keys = Object.keys(def.shape);
  const ownSymbols = Object.getOwnPropertySymbols(def.shape);
  const symbolKeys = ownSymbols.length ? ownSymbols : NO_SYMBOL_KEYS;
  const allKeys = symbolKeys.length ? [...keys, ...symbolKeys] : keys;
  for (const k of allKeys) {
    if (!def.shape?.[k]?._zod?.traits?.has("$ZodType")) {
      throw new Error(`Invalid element at key "${String(k)}": expected a Zod schema`);
    }
  }
  const okeys = optionalKeys(def.shape);
  return {
    ...def,
    allKeys,
    symbolKeys,
    // string-only: handleCatchall matches it against `for...in`, which never yields a symbol
    keySet: new Set(keys),
    numKeys: keys.length,
    optionalKeys: new Set(okeys),
  };
}
__name(normalizeDef, "normalizeDef");
function handleCatchall(proms, input, payload, ctx, def, inst, abortEarly) {
  const unrecognized = [];
  const keySet = def.keySet;
  const _catchall = def.catchall._zod;
  const t = _catchall.def.type;
  const optin = _catchall.optin;
  const optout = _catchall.optout;
  let seen = 0;
  for (const key in input) {
    if (abortEarly && payload.issues.length !== seen) {
      if (aborted(payload, seen)) break;
      seen = payload.issues.length;
    }
    if (keySet.has(key)) continue;
    if (key === "__proto__") {
      if (t === "never") unrecognized.push(key);
      continue;
    }
    if (t === "never") {
      unrecognized.push(key);
      continue;
    }
    const r = _catchall.run({ value: input[key], issues: [] }, ctx);
    if (r instanceof Promise) {
      proms.push(r.then((r2) => handlePropertyResult(r2, payload, key, input, optin, optout)));
    } else {
      handlePropertyResult(r, payload, key, input, optin, optout);
    }
  }
  if (unrecognized.length) {
    payload.issues.push({
      code: "unrecognized_keys",
      keys: unrecognized,
      input,
      inst,
      // Describes the shape of the input, not the validity of the parsed value, so it never aborts. The parse still fails; the schema's own checks just get to run first, and an enclosing intersection can reconcile the key against a sibling operand.
      continue: true,
    });
  }
  if (!proms.length) return payload;
  return Promise.all(proms).then(() => {
    return payload;
  });
}
__name(handleCatchall, "handleCatchall");
var $ZodObject = /* @__PURE__ */ $constructor("$ZodObject", (inst, def) => {
  $ZodType.init(inst, def);
  const desc = Object.getOwnPropertyDescriptor(def, "shape");
  const sh = desc?.get ? desc.get.raw : (def.shape ?? {});
  if (sh) {
    const get = /* @__PURE__ */ __name(() => {
      const newSh = { ...sh };
      Object.defineProperty(def, "shape", { value: newSh });
      get.raw = newSh;
      return newSh;
    }, "get");
    get.raw = sh;
    Object.defineProperty(def, "shape", { get });
  }
  const _normalized = cached(() => normalizeDef(def));
  defineLazyInternal(inst, "propValues", (zod) => {
    const shape = zod.def.shape;
    const propValues = {};
    for (const key in shape) {
      const field = shape[key]._zod;
      if (field.values) {
        if (!Object.hasOwn(propValues, key)) {
          assignProp(propValues, key, /* @__PURE__ */ new Set());
        }
        for (const v of field.values) propValues[key].add(v);
        if (field.optin !== void 0) propValues[key].add(void 0);
      }
    }
    return propValues;
  });
  const isObject2 = isObject;
  const catchall = def.catchall;
  let value;
  const memo = globalConfig.memoizer;
  memo?.attach(inst);
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject2(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst,
      });
      return payload;
    }
    payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
    const proms = [];
    const shape = value.shape;
    const abortEarly = ctx?.abortEarly;
    let seen = payload.issues.length;
    for (const key of value.allKeys) {
      if (abortEarly && payload.issues.length !== seen) {
        if (aborted(payload, seen)) break;
        seen = payload.issues.length;
      }
      if (key === "__proto__") continue;
      const el = shape[key];
      const optin = el._zod.optin;
      const optout = el._zod.optout;
      const r = el._zod.run({ value: input[key], issues: [] }, ctx);
      if (r instanceof Promise) {
        proms.push(r.then((r2) => handlePropertyResult(r2, payload, key, input, optin, optout)));
      } else {
        handlePropertyResult(r, payload, key, input, optin, optout);
      }
    }
    if (!catchall) {
      return proms.length ? Promise.all(proms).then(() => payload) : payload;
    }
    return handleCatchall(proms, input, payload, ctx, _normalized.value, inst, abortEarly === true);
  };
});
function handleUnionResults(results, final, inst, ctx) {
  for (const result of results) {
    if (result.issues.length === 0) {
      final.value = result.value;
      return final;
    }
  }
  const nonaborted = results.filter((r) => !aborted(r));
  if (nonaborted.length === 1) {
    final.value = nonaborted[0].value;
    return nonaborted[0];
  }
  final.issues.push({
    code: "invalid_union",
    input: final.value,
    inst,
    errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config()))),
  });
  return final;
}
__name(handleUnionResults, "handleUnionResults");
var $ZodUnion = /* @__PURE__ */ $constructor("$ZodUnion", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "optin", (zod) =>
    zod.def.options.some((o) => o._zod.optin === "defaulted")
      ? "defaulted"
      : zod.def.options.some((o) => o._zod.optin !== void 0)
        ? "optional"
        : void 0,
  );
  defineLazyInternal(inst, "optout", (zod) =>
    zod.def.options.some((o) => o._zod.optout === "optional") ? "optional" : void 0,
  );
  defineLazyInternal(inst, "values", (zod) => {
    if (zod.def.options.every((o) => o._zod.values)) {
      return new Set(zod.def.options.flatMap((option) => Array.from(option._zod.values)));
    }
    return void 0;
  });
  defineLazyInternal(inst, "pattern", (zod) => {
    if (zod.def.options.every((o) => o._zod.pattern)) {
      const patterns = zod.def.options.map((o) => o._zod.pattern);
      return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
    }
    return void 0;
  });
  const first = def.options.length === 1 ? def.options[0]._zod.run : null;
  inst._zod.parse = (payload, ctx) => {
    if (first) {
      return first(payload, ctx);
    }
    let async = false;
    const results = [];
    for (const option of def.options) {
      const result = option._zod.run(
        {
          value: payload.value,
          issues: [],
        },
        ctx,
      );
      if (result instanceof Promise) {
        results.push(result);
        async = true;
      } else {
        if (result.issues.length === 0) return result;
        results.push(result);
      }
    }
    if (!async) return handleUnionResults(results, payload, inst, ctx);
    return Promise.all(results).then((results2) => {
      return handleUnionResults(results2, payload, inst, ctx);
    });
  };
});
function discriminatorMap(def) {
  const map = /* @__PURE__ */ new Map();
  for (const option of def.options) {
    const values = option._zod.propValues?.[def.discriminator];
    if (!values || values.size === 0)
      throw new Error(`Invalid discriminated union option at index "${def.options.indexOf(option)}"`);
    for (const value of values) {
      if (map.has(value)) {
        if (value !== void 0) throw new Error(`Duplicate discriminator value "${String(value)}"`);
        map.set(value, null);
      } else {
        map.set(value, option);
      }
    }
  }
  return map;
}
__name(discriminatorMap, "discriminatorMap");
var $ZodDiscriminatedUnion = /* @__PURE__ */ $constructor("$ZodDiscriminatedUnion", (inst, def) => {
  def.inclusive = false;
  $ZodUnion.init(inst, def);
  const _super = inst._zod.parse;
  defineLazyInternal(inst, "propValues", (zod) => {
    const propValues = {};
    let undefinedCount = 0;
    for (const option of zod.def.options) {
      const pv = option._zod.propValues;
      if (!pv || Object.keys(pv).length === 0)
        throw new Error(`Invalid discriminated union option at index "${zod.def.options.indexOf(option)}"`);
      if (pv[zod.def.discriminator]?.has(void 0)) undefinedCount++;
      for (const [k, v] of Object.entries(pv)) {
        if (!Object.hasOwn(propValues, k)) {
          assignProp(propValues, k, /* @__PURE__ */ new Set());
        }
        for (const val of v) {
          propValues[k].add(val);
        }
      }
    }
    if (!zod.def.unionFallback && undefinedCount > 1) propValues[zod.def.discriminator]?.delete(void 0);
    return propValues;
  });
  def.options.forEach((option, i) => {
    const propShape = rawShape(option._zod.def);
    if (propShape && !Object.hasOwn(propShape, def.discriminator)) {
      throw new Error(`Invalid discriminated union option at index "${i}"`);
    }
  });
  const disc = cached(() => discriminatorMap(def));
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!isObject(input)) {
      payload.issues.push({
        code: "invalid_type",
        expected: "object",
        input,
        inst,
      });
      return payload;
    }
    const value = input?.[def.discriminator];
    const opt = disc.value.get(value);
    if (opt && (value !== void 0 || ctx.direction !== "backward")) {
      return opt._zod.run(payload, ctx);
    }
    if (def.unionFallback || ctx.direction === "backward") {
      return _super(payload, ctx);
    }
    payload.issues.push({
      code: "invalid_union",
      errors: [],
      note: "No matching discriminator",
      discriminator: def.discriminator,
      options: Array.from(disc.value.keys()).filter((value2) => disc.value.get(value2) !== null),
      input,
      path: [def.discriminator],
      inst,
    });
    return payload;
  };
});
var $ZodTuple = /* @__PURE__ */ $constructor("$ZodTuple", (inst, def) => {
  $ZodType.init(inst, def);
  const items = def.items;
  const memo = globalConfig.memoizer;
  memo?.attach(inst);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!Array.isArray(input)) {
      payload.issues.push({
        input,
        inst,
        expected: "tuple",
        code: "invalid_type",
      });
      return payload;
    }
    payload.value = memo ? memo.alloc(inst, payload, [], ctx) : [];
    const proms = [];
    const optinStart = getTupleOptStart(items, "optin");
    const optoutStart = getTupleOptStart(items, "optout");
    if (!def.rest) {
      if (input.length < optinStart) {
        payload.issues.push({
          code: "too_small",
          minimum: optinStart,
          inclusive: true,
          input,
          inst,
          origin: "array",
        });
        return payload;
      }
      if (input.length > items.length) {
        payload.issues.push({
          code: "too_big",
          maximum: items.length,
          inclusive: true,
          input,
          inst,
          origin: "array",
        });
      }
    }
    const itemResults = new Array(items.length);
    const abortEarly = def.rest ? ctx?.abortEarly : void 0;
    let itemAborted = false;
    for (let i = 0; i < items.length; i++) {
      const r = items[i]._zod.run({ value: input[i], issues: [] }, ctx);
      if (r instanceof Promise) {
        proms.push(
          r.then((rr) => {
            itemResults[i] = rr;
          }),
        );
      } else {
        itemResults[i] = r;
        if (abortEarly && !itemAborted && r.issues.length) itemAborted = aborted(r);
      }
    }
    if (def.rest && !itemAborted) {
      let i = items.length - 1;
      const rest = input.slice(items.length);
      let seen = payload.issues.length;
      for (const el of rest) {
        if (abortEarly && payload.issues.length !== seen) {
          if (aborted(payload, seen)) break;
          seen = payload.issues.length;
        }
        i++;
        const result = def.rest._zod.run({ value: el, issues: [] }, ctx);
        if (result instanceof Promise) {
          proms.push(result.then((r) => handleTupleResult(r, payload, i)));
        } else {
          handleTupleResult(result, payload, i);
        }
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() =>
        handleTupleResults(itemResults, payload, items, input, optoutStart),
      );
    }
    return handleTupleResults(itemResults, payload, items, input, optoutStart);
  };
});
function getTupleOptStart(items, key) {
  for (let i = items.length - 1; i >= 0; i--) {
    const omittable = key === "optin" ? items[i]._zod.optin !== void 0 : items[i]._zod.optout === "optional";
    if (!omittable) return i + 1;
  }
  return 0;
}
__name(getTupleOptStart, "getTupleOptStart");
function handleTupleResult(result, final, index) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(index, result.issues));
  }
  final.value[index] = result.value;
}
__name(handleTupleResult, "handleTupleResult");
function handleTupleResults(itemResults, final, items, input, optoutStart) {
  for (let i = 0; i < items.length; i++) {
    const r = itemResults[i];
    const isPresent = i < input.length;
    if (!isPresent && i >= optoutStart && items[i]._zod.optin === "optional") {
      final.value.length = i;
      break;
    }
    if (r.issues.length) {
      if (!isPresent && i >= optoutStart) {
        final.value.length = i;
        break;
      }
      final.issues.push(...prefixIssues(i, r.issues));
    }
    final.value[i] = r.value;
  }
  for (let i = final.value.length - 1; i >= input.length; i--) {
    if (items[i]._zod.optout === "optional" && final.value[i] === void 0) {
      final.value.length = i;
    } else {
      break;
    }
  }
  return final;
}
__name(handleTupleResults, "handleTupleResults");
var $ZodRecord = /* @__PURE__ */ $constructor("$ZodRecord", (inst, def) => {
  $ZodType.init(inst, def);
  const memo = globalConfig.memoizer;
  memo?.attach(inst);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!isPlainObject(input)) {
      payload.issues.push({
        expected: "record",
        code: "invalid_type",
        input,
        inst,
      });
      return payload;
    }
    const proms = [];
    const values = def.keyType._zod.values;
    if (values && !def.partial) {
      payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
      const recordKeys = /* @__PURE__ */ new Set();
      for (const key of values) {
        if (typeof key === "string" || typeof key === "number" || typeof key === "symbol") {
          recordKeys.add(typeof key === "number" ? key.toString() : key);
          if (key === "__proto__") continue;
          const keyResult = def.keyType._zod.run({ value: key, issues: [] }, ctx);
          if (keyResult instanceof Promise) {
            throw new Error("Async schemas not supported in object keys currently");
          }
          if (keyResult.issues.length) {
            payload.issues.push({
              code: "invalid_key",
              origin: "record",
              issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
              input: key,
              path: [key],
              inst,
            });
            continue;
          }
          const outKey = keyResult.value;
          if (outKey === "__proto__") continue;
          const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
          if (result instanceof Promise) {
            proms.push(
              result.then((result2) => {
                if (result2.issues.length) {
                  payload.issues.push(...prefixIssues(key, result2.issues));
                }
                payload.value[outKey] = result2.value;
              }),
            );
          } else {
            if (result.issues.length) {
              payload.issues.push(...prefixIssues(key, result.issues));
            }
            payload.value[outKey] = result.value;
          }
        }
      }
      let unrecognized;
      for (const key in input) {
        if (!recordKeys.has(key)) {
          if (def.mode === "loose") {
            if (key === "__proto__") continue;
            payload.value[key] = input[key];
          } else {
            unrecognized = unrecognized ?? [];
            unrecognized.push(key);
          }
        }
      }
      if (unrecognized && unrecognized.length > 0) {
        payload.issues.push({
          code: "unrecognized_keys",
          input,
          inst,
          keys: unrecognized,
          continue: true,
        });
      }
    } else {
      payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
      let unrecognized;
      for (const key of Reflect.ownKeys(input)) {
        if (key === "__proto__") continue;
        if (!Object.prototype.propertyIsEnumerable.call(input, key)) continue;
        let keyResult = def.keyType._zod.run({ value: key, issues: [] }, ctx);
        if (keyResult instanceof Promise) {
          throw new Error("Async schemas not supported in object keys currently");
        }
        const checkNumericKey = typeof key === "string" && number.test(key) && keyResult.issues.length;
        if (checkNumericKey) {
          const retryResult = def.keyType._zod.run({ value: Number(key), issues: [] }, ctx);
          if (retryResult instanceof Promise) {
            throw new Error("Async schemas not supported in object keys currently");
          }
          if (retryResult.issues.length === 0) {
            keyResult = retryResult;
          }
        }
        if (keyResult.issues.length) {
          if (def.mode === "loose") {
            payload.value[key] = input[key];
          } else if (values) {
            unrecognized = unrecognized ?? [];
            unrecognized.push(key);
          } else {
            payload.issues.push({
              code: "invalid_key",
              origin: "record",
              issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
              input: key,
              path: [key],
              inst,
            });
          }
          continue;
        }
        const outKey = keyResult.value;
        if (outKey === "__proto__") continue;
        const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
        if (result instanceof Promise) {
          proms.push(
            result.then((result2) => {
              if (result2.issues.length) {
                payload.issues.push(...prefixIssues(key, result2.issues));
              }
              payload.value[outKey] = result2.value;
            }),
          );
        } else {
          if (result.issues.length) {
            payload.issues.push(...prefixIssues(key, result.issues));
          }
          payload.value[outKey] = result.value;
        }
      }
      if (unrecognized && unrecognized.length > 0) {
        payload.issues.push({
          code: "unrecognized_keys",
          input,
          inst,
          keys: unrecognized,
          continue: true,
        });
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
});
var $ZodLiteral = /* @__PURE__ */ $constructor("$ZodLiteral", (inst, def) => {
  $ZodType.init(inst, def);
  const values = new Set(def.values);
  inst._zod.values = values;
  defineLazyInternal(inst, "pattern", (zod) => {
    const vals = zod.def.values;
    return new RegExp(
      vals.length
        ? `^(${vals.map((o) => (typeof o === "string" ? escapeRegex(o) : o ? escapeRegex(o.toString()) : String(o))).join("|")})$`
        : "^[^\\s\\S]$",
    );
  });
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (values.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values: def.values,
      input,
      inst,
    });
    return payload;
  };
});
function handleOptionalResult(payload, result) {
  payload.value = result.issues.length ? void 0 : result.value;
  return payload;
}
__name(handleOptionalResult, "handleOptionalResult");
var $ZodOptional = /* @__PURE__ */ $constructor("$ZodOptional", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "optin", (zod) =>
    zod.def.innerType._zod.optin === "defaulted" ? "defaulted" : "optional",
  );
  inst._zod.optout = "optional";
  defineLazyInternal(inst, "values", (zod) => {
    const values = zod.def.innerType._zod.values;
    return values ? /* @__PURE__ */ new Set([...values, void 0]) : void 0;
  });
  defineLazyInternal(inst, "pattern", (zod) => {
    const pattern = zod.def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : void 0;
  });
  inst._zod.parse = (payload, ctx) => {
    if (payload.value === void 0) {
      if (def.innerType._zod.optin !== "defaulted") return payload;
      const result = def.innerType._zod.run({ value: payload.value, issues: [] }, ctx);
      if (result instanceof Promise) return result.then((result2) => handleOptionalResult(payload, result2));
      return handleOptionalResult(payload, result);
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodFunction = /* @__PURE__ */ $constructor("$ZodFunction", (inst, def) => {
  $ZodType.init(inst, def);
  Object.defineProperty(inst, "_def", { value: def });
  inst._zod.def = def;
  inst.implement = (func) => {
    if (typeof func !== "function") {
      throw new Error("implement() must be called with a function");
    }
    return Object.defineProperty(
      function (...args) {
        const parsedArgs = inst._def.input ? parse(inst._def.input, args) : args;
        const result = Reflect.apply(func, this, parsedArgs);
        if (inst._def.output) {
          return parse(inst._def.output, result);
        }
        return result;
      },
      "_zod",
      { value: inst._zod, enumerable: false },
    );
  };
  inst.implementAsync = (func) => {
    if (typeof func !== "function") {
      throw new Error("implementAsync() must be called with a function");
    }
    return Object.defineProperty(
      async function (...args) {
        const parsedArgs = inst._def.input ? await parseAsync(inst._def.input, args) : args;
        const result = await Reflect.apply(func, this, parsedArgs);
        if (inst._def.output) {
          return await parseAsync(inst._def.output, result);
        }
        return result;
      },
      "_zod",
      { value: inst._zod, enumerable: false },
    );
  };
  inst._zod.parse = (payload, _ctx) => {
    if (typeof payload.value !== "function") {
      payload.issues.push({
        code: "invalid_type",
        expected: "function",
        input: payload.value,
        inst,
      });
      return payload;
    }
    const hasPromiseOutput = inst._def.output && inst._def.output._zod.def.type === "promise";
    if (hasPromiseOutput) {
      payload.value = inst.implementAsync(payload.value);
    } else {
      payload.value = inst.implement(payload.value);
    }
    return payload;
  };
  inst.input = (...args) => {
    const F = inst.constructor;
    if (Array.isArray(args[0])) {
      return new F({
        type: "function",
        input: new $ZodTuple({
          type: "tuple",
          items: args[0],
          rest: args[1],
        }),
        output: inst._def.output,
      });
    }
    return new F({
      type: "function",
      input: args[0],
      output: inst._def.output,
    });
  };
  inst.output = (output) => {
    const F = inst.constructor;
    return new F({
      type: "function",
      input: inst._def.input,
      output,
    });
  };
  return inst;
});
var $ZodLazy = /* @__PURE__ */ $constructor("$ZodLazy", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "innerType", () => {
    const d = def;
    if (!d._cachedInner) d._cachedInner = def.getter();
    return d._cachedInner;
  });
  defineLazyInternal(inst, "pattern", (zod) => zod.innerType?._zod?.pattern);
  defineLazyInternal(inst, "propValues", (zod) => zod.innerType?._zod?.propValues);
  defineLazyInternal(inst, "optin", (zod) => zod.innerType?._zod?.optin ?? void 0);
  defineLazyInternal(inst, "optout", (zod) => zod.innerType?._zod?.optout ?? void 0);
  inst._zod.parse = (payload, ctx) => {
    const inner = inst._zod.innerType;
    return inner._zod.run(payload, ctx);
  };
});
var $ZodCustom = /* @__PURE__ */ $constructor("$ZodCustom", (inst, def) => {
  $ZodCheck.init(inst, def);
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _) => {
    return payload;
  };
  inst._zod.check = (payload) => {
    const input = payload.value;
    const r = def.fn(input);
    if (r instanceof Promise) {
      return r.then((r2) => handleRefineResult(r2, payload, input, inst));
    }
    handleRefineResult(r, payload, input, inst);
    return;
  };
});
function handleRefineResult(result, payload, input, inst) {
  if (!result) {
    const _iss = {
      code: "custom",
      input,
      inst,
      // incorporates params.error into issue reporting
      path: [...(inst._zod.def.path ?? [])],
      // incorporates params.error into issue reporting
      continue: !inst._zod.def.abort,
      // params: inst._zod.def.params,
    };
    if (inst._zod.def.params) _iss.params = inst._zod.def.params;
    payload.issues.push(issue(_iss));
  }
}
__name(handleRefineResult, "handleRefineResult");

// ../../node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/api.js
function snapshotChecks(def) {
  if (def.checks) def.checks = [...def.checks];
  return def;
}
__name(snapshotChecks, "snapshotChecks");
// @__NO_SIDE_EFFECTS__
function _string(Class, params) {
  return new Class(snapshotChecks({ type: "string", ...normalizeParams(params) }));
}
__name(_string, "_string");
// @__NO_SIDE_EFFECTS__
function _number(Class, params) {
  return new Class(snapshotChecks({ type: "number", checks: [], ...normalizeParams(params) }));
}
__name(_number, "_number");
// @__NO_SIDE_EFFECTS__
function _int(Class, params) {
  return new Class({
    type: "number",
    check: "number_format",
    abort: false,
    format: "safeint",
    ...normalizeParams(params),
  });
}
__name(_int, "_int");
// @__NO_SIDE_EFFECTS__
function _boolean(Class, params) {
  return new Class({
    type: "boolean",
    ...normalizeParams(params),
  });
}
__name(_boolean, "_boolean");
// @__NO_SIDE_EFFECTS__
function _null2(Class, params) {
  return new Class({
    type: "null",
    ...normalizeParams(params),
  });
}
__name(_null2, "_null");
// @__NO_SIDE_EFFECTS__
function _unknown(Class) {
  return new Class({
    type: "unknown",
  });
}
__name(_unknown, "_unknown");
// @__NO_SIDE_EFFECTS__
function _never(Class, params) {
  return new Class({
    type: "never",
    ...normalizeParams(params),
  });
}
__name(_never, "_never");
// @__NO_SIDE_EFFECTS__
function _gt(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: false,
  });
}
__name(_gt, "_gt");
// @__NO_SIDE_EFFECTS__
function _positive(params) {
  return /* @__PURE__ */ _gt(0, params);
}
__name(_positive, "_positive");
// @__NO_SIDE_EFFECTS__
function _minLength(minimum, params) {
  return new $ZodCheckMinLength({
    check: "min_length",
    ...normalizeParams(params),
    minimum,
  });
}
__name(_minLength, "_minLength");
// @__NO_SIDE_EFFECTS__
function _regex(pattern, params) {
  return new $ZodCheckRegex({
    check: "string_format",
    format: "regex",
    ...normalizeParams(params),
    pattern,
  });
}
__name(_regex, "_regex");
// @__NO_SIDE_EFFECTS__
function _startsWith(prefix, params) {
  return new $ZodCheckStartsWith({
    check: "string_format",
    format: "starts_with",
    ...normalizeParams(params),
    prefix,
  });
}
__name(_startsWith, "_startsWith");
// @__NO_SIDE_EFFECTS__
function _custom(Class, fn, _params) {
  const norm = normalizeParams(_params);
  norm.abort ?? (norm.abort = true);
  const schema = new Class({
    type: "custom",
    check: "custom",
    fn,
    ...norm,
  });
  return schema;
}
__name(_custom, "_custom");
// @__NO_SIDE_EFFECTS__
function _refine(Class, fn, _params) {
  const schema = new Class({
    type: "custom",
    check: "custom",
    fn,
    ...normalizeParams(_params),
  });
  return schema;
}
__name(_refine, "_refine");

// ../../node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/mini/schemas.js
var ZodMiniType = /* @__PURE__ */ $constructor(
  "ZodMiniType",
  (inst, def) => {
    if (!inst._zod) throw new Error("Uninitialized schema in ZodMiniType.");
    $ZodType.init(inst, def);
    inst.def = def;
    inst.type = def.type;
  },
  {
    // `with` is an alias for `check`: the same function object, not a wrapper.
    get with() {
      return this.check;
    },
    set with(value) {
      own(this, "with", value);
    },
    parse(data, params) {
      return parse(this, data, params, { callee: this.parse });
    },
    parseAsync(data, params) {
      return parseAsync(this, data, params, { callee: this.parseAsync });
    },
    safeParse(data, params) {
      return safeParse(this, data, params);
    },
    safeParseAsync(data, params) {
      return safeParseAsync(this, data, params);
    },
    check(...checks) {
      const def = this.def;
      return this.clone(
        {
          ...def,
          checks: [
            ...(def.checks ?? []),
            ...checks.map((ch) =>
              typeof ch === "function" ? { _zod: { check: ch, def: { check: "custom" }, onattach: [] } } : ch,
            ),
          ],
        },
        { parent: true },
      );
    },
    clone(_def, params) {
      return clone(this, _def, params);
    },
    brand() {
      return this;
    },
    register(reg, meta2) {
      reg.add(this, meta2);
      return this;
    },
    apply(fn, ...args) {
      return args.length === 0 ? fn(this) : fn(this, ...args);
    },
  },
);
var ZodMiniString = /* @__PURE__ */ $constructor("ZodMiniString", (inst, def) => {
  $ZodString.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function string2(params) {
  return _string(ZodMiniString, params);
}
__name(string2, "string");
var ZodMiniNumber = /* @__PURE__ */ $constructor("ZodMiniNumber", (inst, def) => {
  $ZodNumber.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function number2(params) {
  return _number(ZodMiniNumber, params);
}
__name(number2, "number");
var ZodMiniNumberFormat = /* @__PURE__ */ $constructor("ZodMiniNumberFormat", (inst, def) => {
  $ZodNumberFormat.init(inst, def);
  ZodMiniNumber.init(inst, def);
});
function int(params) {
  return _int(ZodMiniNumberFormat, params);
}
__name(int, "int");
var ZodMiniBoolean = /* @__PURE__ */ $constructor("ZodMiniBoolean", (inst, def) => {
  $ZodBoolean.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function boolean2(params) {
  return _boolean(ZodMiniBoolean, params);
}
__name(boolean2, "boolean");
var ZodMiniNull = /* @__PURE__ */ $constructor("ZodMiniNull", (inst, def) => {
  $ZodNull.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function _null3(params) {
  return _null2(ZodMiniNull, params);
}
__name(_null3, "_null");
var ZodMiniUnknown = /* @__PURE__ */ $constructor("ZodMiniUnknown", (inst, def) => {
  $ZodUnknown.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function unknown() {
  return _unknown(ZodMiniUnknown);
}
__name(unknown, "unknown");
var ZodMiniNever = /* @__PURE__ */ $constructor("ZodMiniNever", (inst, def) => {
  $ZodNever.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function never(params) {
  return _never(ZodMiniNever, params);
}
__name(never, "never");
var ZodMiniArray = /* @__PURE__ */ $constructor("ZodMiniArray", (inst, def) => {
  $ZodArray.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function array(element, params) {
  return new ZodMiniArray({
    type: "array",
    element,
    ...normalizeParams(params),
  });
}
__name(array, "array");
var ZodMiniObject = /* @__PURE__ */ $constructor("ZodMiniObject", (inst, def) => {
  $ZodObject.init(inst, def);
  ZodMiniType.init(inst, def);
  installLazyProp(inst, "shape", (self) => self._zod.def.shape, false);
});
// @__NO_SIDE_EFFECTS__
function object(shape, params) {
  const def = {
    type: "object",
    shape: shape ?? {},
    ...normalizeParams(params),
  };
  return new ZodMiniObject(def);
}
__name(object, "object");
// @__NO_SIDE_EFFECTS__
function strictObject(shape, params) {
  return new ZodMiniObject({
    type: "object",
    shape,
    catchall: /* @__PURE__ */ never(),
    ...normalizeParams(params),
  });
}
__name(strictObject, "strictObject");
var ZodMiniUnion = /* @__PURE__ */ $constructor("ZodMiniUnion", (inst, def) => {
  $ZodUnion.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function union(options, params) {
  return new ZodMiniUnion({
    type: "union",
    options,
    ...normalizeParams(params),
  });
}
__name(union, "union");
var ZodMiniDiscriminatedUnion = /* @__PURE__ */ $constructor("ZodMiniDiscriminatedUnion", (inst, def) => {
  $ZodDiscriminatedUnion.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function discriminatedUnion(discriminator, options, params) {
  return new ZodMiniDiscriminatedUnion({
    type: "union",
    options,
    discriminator,
    ...normalizeParams(params),
  });
}
__name(discriminatedUnion, "discriminatedUnion");
var ZodMiniTuple = /* @__PURE__ */ $constructor("ZodMiniTuple", (inst, def) => {
  $ZodTuple.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function tuple(items, _paramsOrRest, _params) {
  const hasRest = _paramsOrRest instanceof $ZodType;
  const params = hasRest ? _params : _paramsOrRest;
  const rest = hasRest ? _paramsOrRest : null;
  return new ZodMiniTuple({
    type: "tuple",
    items,
    rest,
    ...normalizeParams(params),
  });
}
__name(tuple, "tuple");
var ZodMiniRecord = /* @__PURE__ */ $constructor("ZodMiniRecord", (inst, def) => {
  $ZodRecord.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function record(keyType, valueType, params) {
  if (!valueType || !valueType._zod) {
    return new ZodMiniRecord({
      type: "record",
      keyType: /* @__PURE__ */ string2(),
      valueType: keyType,
      ...normalizeParams(valueType),
    });
  }
  return new ZodMiniRecord({
    type: "record",
    keyType,
    valueType,
    ...normalizeParams(params),
  });
}
__name(record, "record");
var ZodMiniLiteral = /* @__PURE__ */ $constructor("ZodMiniLiteral", (inst, def) => {
  $ZodLiteral.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function literal(value, params) {
  return new ZodMiniLiteral({
    type: "literal",
    values: Array.isArray(value) ? value : [value],
    ...normalizeParams(params),
  });
}
__name(literal, "literal");
var ZodMiniOptional = /* @__PURE__ */ $constructor("ZodMiniOptional", (inst, def) => {
  $ZodOptional.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function optional(innerType) {
  return new ZodMiniOptional({
    type: "optional",
    innerType,
  });
}
__name(optional, "optional");
var ZodMiniLazy = /* @__PURE__ */ $constructor("ZodMiniLazy", (inst, def) => {
  $ZodLazy.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function _lazy(getter) {
  return new ZodMiniLazy({
    type: "lazy",
    getter,
  });
}
__name(_lazy, "_lazy");
var ZodMiniCustom = /* @__PURE__ */ $constructor("ZodMiniCustom", (inst, def) => {
  $ZodCustom.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function custom(fn, _params) {
  return _custom(ZodMiniCustom, fn ?? (() => true), _params);
}
__name(custom, "custom");
// @__NO_SIDE_EFFECTS__
function refine(fn, _params = {}) {
  return _refine(ZodMiniCustom, fn, _params);
}
__name(refine, "refine");
// @__NO_SIDE_EFFECTS__
function _instanceof(cls, params = {}) {
  const inst = /* @__PURE__ */ custom((data) => data instanceof cls, params);
  inst._zod.bag.Class = cls;
  inst._zod.check = (payload) => {
    if (!(payload.value instanceof cls)) {
      payload.issues.push({
        code: "invalid_type",
        expected: cls.name,
        input: payload.value,
        inst,
        path: [...(inst._zod.def.path ?? [])],
      });
    }
  };
  return inst;
}
__name(_instanceof, "_instanceof");
// @__NO_SIDE_EFFECTS__
function json() {
  const jsonSchema2 = /* @__PURE__ */ _lazy(() => {
    return /* @__PURE__ */ union([
      /* @__PURE__ */ string2(),
      /* @__PURE__ */ number2(),
      /* @__PURE__ */ boolean2(),
      /* @__PURE__ */ _null3(),
      /* @__PURE__ */ array(jsonSchema2),
      /* @__PURE__ */ record(/* @__PURE__ */ string2(), jsonSchema2),
    ]);
  });
  return jsonSchema2;
}
__name(json, "json");
var ZodMiniFunction = /* @__PURE__ */ $constructor("ZodMiniFunction", (inst, def) => {
  $ZodFunction.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function _function(params) {
  return new ZodMiniFunction({
    type: "function",
    input: Array.isArray(params?.input)
      ? /* @__PURE__ */ tuple(params?.input)
      : (params?.input ?? /* @__PURE__ */ array(/* @__PURE__ */ unknown())),
    output: params?.output ?? /* @__PURE__ */ unknown(),
  });
}
__name(_function, "_function");

// ../../node_modules/.pnpm/@cloudflare+sandbox@1.0.3/node_modules/@cloudflare/sandbox/dist/index.mjs
import { constants } from "node:os";

// ../../node_modules/.pnpm/aws4fetch@1.0.20/node_modules/aws4fetch/dist/aws4fetch.esm.mjs
var encoder = new TextEncoder();

// ../../node_modules/.pnpm/@cloudflare+sandbox@1.0.3/node_modules/@cloudflare/sandbox/dist/index.mjs
var PART_PATH = /^\/parts\/([1-9][0-9]{0,8})$/;
var RANGE = /^bytes=([0-9]{1,15})-([0-9]{1,15})$/;
var MAX_DETAIL_LENGTH = 1024;
async function handleDirectoryBackupRequest(request, props, resolveBucket) {
  if (props.protocolVersion !== 1) return text(500, "gateway protocol is incompatible");
  switch (props.mode) {
    case "write":
      return servePart(request, resolveBucket(props.binding), props.key, props.uploadId);
    case "read":
      return serveRange(request, resolveBucket(props.binding), props.key);
    default:
      return text(403, "no directory backup operation holds a grant");
  }
}
__name(handleDirectoryBackupRequest, "handleDirectoryBackupRequest");
async function servePart(request, bucket, key, uploadId) {
  const part = PART_PATH.exec(new URL(request.url).pathname);
  if (request.method !== "PUT" || part === null) return text(403, "the grant allows only part uploads");
  const length = Number(request.headers.get("content-length") ?? NaN);
  if (!Number.isSafeInteger(length) || length <= 0 || request.body === null)
    return text(411, "a part needs a Content-Length");
  try {
    const { readable, writable } = new FixedLengthStream(length);
    const upload = bucket.resumeMultipartUpload(key, uploadId);
    const [uploaded] = await Promise.all([
      upload.uploadPart(Number(part[1]), readable),
      request.body.pipeTo(writable),
    ]);
    return Response.json({ etag: uploaded.etag });
  } catch (error) {
    return text(502, error instanceof Error ? error.message : "R2 rejected the part");
  }
}
__name(servePart, "servePart");
async function serveRange(request, bucket, key) {
  const range = RANGE.exec(request.headers.get("range") ?? "");
  if (request.method !== "GET" || new URL(request.url).pathname !== "/object" || range === null)
    return text(403, "the grant allows only ranged reads of the backup");
  const offset = Number(range[1]);
  const last = Number(range[2]);
  if (last < offset) return text(416, "invalid range");
  try {
    const object2 = await bucket.get(key, {
      range: {
        offset,
        length: last - offset + 1,
      },
    });
    if (object2 === null) return text(404, "the backup object does not exist");
    const end = Math.min(last, object2.size - 1);
    if (end < offset) return text(416, "the range starts past the end of the object");
    return new Response(object2.body, {
      status: 206,
      headers: { "content-range": `bytes ${offset}-${end}/${object2.size}` },
    });
  } catch (error) {
    return text(502, error instanceof Error ? error.message : "R2 rejected the range");
  }
}
__name(serveRange, "serveRange");
function text(status, detail) {
  return new Response(detail.slice(0, MAX_DETAIL_LENGTH), { status });
}
__name(text, "text");
var DirectoryBackupGateway = class extends WorkerEntrypoint {
  static {
    __name(this, "DirectoryBackupGateway");
  }
  fetch(request) {
    return handleDirectoryBackupRequest(request, this.ctx.props, this.#bucket);
  }
  async createUpload(name) {
    const { bucket, key } = this.#control();
    const options = { httpMetadata: { contentType: "application/zstd" } };
    if (name !== void 0) options.customMetadata = { name };
    return (await bucket.createMultipartUpload(key, options)).uploadId;
  }
  async completeUpload(uploadId, parts) {
    const { bucket, key } = this.#control();
    return (
      await bucket.resumeMultipartUpload(key, uploadId).complete(
        parts.map(({ partNumber, etag }) => ({
          partNumber,
          etag,
        })),
      )
    ).size;
  }
  async abortUpload(uploadId) {
    const { bucket, key } = this.#control();
    await bucket.resumeMultipartUpload(key, uploadId).abort();
  }
  async deleteObject() {
    const { bucket, key } = this.#control();
    await bucket.delete(key);
  }
  /** The bucket and key of a control call. Only the Durable Object holds control props. */
  #control() {
    const props = this.ctx.props;
    if (props.protocolVersion !== 1 || props.mode !== "control")
      throw new Error("DirectoryBackupGateway control methods require control props");
    return {
      bucket: this.#bucket(props.binding),
      key: props.key,
    };
  }
  #bucket = /* @__PURE__ */ __name((binding) => {
    const value = Object.getOwnPropertyDescriptor(this.env, binding)?.value;
    if (value === void 0 || !bucketSchema.safeParse(value).success)
      throw new TypeError(`env.${binding} is not an R2 bucket binding`);
    return value;
  }, "#bucket");
};
var bucketSchema = object({
  get: _function(),
  delete: _function(),
  createMultipartUpload: _function(),
  resumeMultipartUpload: _function(),
});
var CANONICAL_ERRNO_NAMES = /* @__PURE__ */ new Map();
for (const [name, value] of Object.entries(constants.errno))
  if (name.startsWith("E") && !CANONICAL_ERRNO_NAMES.has(value)) CANONICAL_ERRNO_NAMES.set(value, name);
for (const preferred of ["EAGAIN", "EDEADLK", "EOPNOTSUPP"]) {
  const value = constants.errno[preferred];
  if (value !== void 0) CANONICAL_ERRNO_NAMES.set(value, preferred);
}
var FileError = class extends Error {
  static {
    __name(this, "FileError");
  }
  name = "SandboxFileError";
  code;
  operation;
  path;
  destination;
  detail;
  constructor(context, code, detail) {
    const subject =
      context.destination === void 0 ? `'${context.path}'` : `'${context.path}' to '${context.destination}'`;
    super(`${context.operation} ${subject}: ${detail}`);
    this.code = code;
    this.operation = context.operation;
    this.path = context.path;
    if (context.destination !== void 0) this.destination = context.destination;
    this.detail = detail;
  }
};
var ProtocolError = class extends Error {
  static {
    __name(this, "ProtocolError");
  }
  name = "SandboxProtocolError";
  code = "SANDBOX_PROTOCOL_ERROR";
  detail;
  constructor(detail, cause) {
    super(detail, cause === void 0 ? void 0 : { cause });
    this.detail = detail;
  }
};
var BackupError = class extends Error {
  static {
    __name(this, "BackupError");
  }
  name = "SandboxBackupError";
  code;
  operation;
  path;
  detail;
  constructor(code, operation, path, detail) {
    super(`${operation} '${path}': ${detail}`);
    this.code = code;
    this.operation = operation;
    this.path = path;
    this.detail = detail;
  }
};
function backupError(code, operation, path, detail) {
  return new BackupError(code, operation, path, detail);
}
__name(backupError, "backupError");
function protocolError(detail, cause) {
  return new ProtocolError(detail, cause);
}
__name(protocolError, "protocolError");
function fileErrorFromErrno(context, errno, detail) {
  const code = CANONICAL_ERRNO_NAMES.get(errno) ?? "UNKNOWN";
  return new FileError(context, code, detail.length > 0 ? detail : code);
}
__name(fileErrorFromErrno, "fileErrorFromErrno");
var optionsSchema = object({});
function validateOptions(options, rules) {
  if (!optionsSchema.safeParse(options).success) throw new TypeError("options must be an object");
  for (const [name, value] of Object.entries(options)) {
    if (value === void 0) continue;
    if (!Object.hasOwn(rules, name)) throw new TypeError(`unknown option "${name}"`);
    const rule = rules[name];
    if (!rule.schema.safeParse(value).success) throw new TypeError(`${name} ${rule.requirement}`);
  }
}
__name(validateOptions, "validateOptions");
var DIRECTORY_BACKUP_FORMAT = "tar+zstd/1";
var SHIM_PATH = "/usr/local/bin/sandbox-shim";
var MAGIC = new Uint8Array([83, 66, 88, 70]);
var PROTOCOL_VERSION = 1;
var HEADER_LENGTH = 10;
var ERROR_PREFIX_LENGTH = 4;
var FRAME_SUCCESS = 0;
var FRAME_FILE_ERROR = 1;
var FRAME_DATA = 2;
var jsonSchema = json();
var jsonDecoder = new TextDecoder("utf-8", { fatal: true });
var AbortMonitor = class {
  static {
    __name(this, "AbortMonitor");
  }
  /**
   * The signal to pass to `exec()`, which follows the caller's until the shim settles. The
   * caller's signal can outlive the call, as AbortSignal.timeout() does, and signalling an exited
   * process logs a runtime error. Undefined when the process must not be signalled.
   */
  signal;
  #promise;
  #dispose = /* @__PURE__ */ __name(() => void 0, "#dispose");
  constructor(signal, abort) {
    if (signal === void 0) return;
    const linked = new AbortController();
    if (abort === "kill") this.signal = linked.signal;
    this.#promise = new Promise((_, reject) => {
      if (signal.aborted) {
        linked.abort(signal.reason);
        reject(signal.reason);
        return;
      }
      const onAbort = /* @__PURE__ */ __name(() => {
        this.dispose();
        linked.abort(signal.reason);
        reject(signal.reason);
      }, "onAbort");
      signal.addEventListener("abort", onAbort, { once: true });
      this.#dispose = () => signal.removeEventListener("abort", onAbort);
    });
    this.#promise.catch(() => void 0);
  }
  waitFor(operation) {
    if (this.#promise === void 0) return operation;
    return Promise.race([this.#promise, operation]);
  }
  dispose() {
    this.#dispose();
    this.#dispose = () => void 0;
  }
};
var ShimSession = class ShimSession2 {
  static {
    __name(this, "ShimSession");
  }
  process;
  #abort;
  #settled = false;
  constructor(process, abort) {
    this.process = process;
    this.#abort = abort;
  }
  static async start(container, command, options, abort = "kill") {
    const monitor = new AbortMonitor(options.signal, abort);
    const starting = container.exec(command, {
      ...options,
      signal: monitor.signal,
    });
    try {
      return new ShimSession2(await monitor.waitFor(starting), monitor);
    } catch (error) {
      monitor.dispose();
      if (abort === "stdin") starting.then(closeStdin$1, () => void 0);
      throw error;
    }
  }
  openStderrControl() {
    if (this.process.stderr === null) throw protocolError("sandbox-shim did not provide stderr");
    return new ShimControl(this.process.stderr.getReader(), this);
  }
  openStdoutControl() {
    if (this.process.stdout === null) throw protocolError("sandbox-shim did not provide stdout");
    return new ShimControl(this.process.stdout.getReader(), this);
  }
  openStdoutReader() {
    if (this.process.stdout === null) throw protocolError("sandbox-shim did not provide stdout");
    return this.process.stdout.getReader();
  }
  openStdinWriter() {
    if (this.process.stdin === null) throw protocolError("sandbox-shim did not provide stdin");
    return this.process.stdin.getWriter();
  }
  waitFor(operation) {
    return this.#abort.waitFor(operation);
  }
  /** Stops following the caller's signal: later waits no longer reject when it aborts. */
  stopFollowingSignal() {
    this.#abort.dispose();
  }
  finish() {
    if (this.#settled) return;
    this.#settled = true;
    this.#abort.dispose();
  }
  /**
   * Waits for a shim that already reported its outcome to exit, so cleanup does not signal an
   * exited process. Never throws: the reported outcome stays authoritative, and if the exit is
   * not observed, terminate() still cleans up.
   */
  async settle() {
    try {
      await this.waitFor(this.process.exitCode);
      this.finish();
    } catch {}
  }
  terminate() {
    if (this.#settled) return;
    this.#settled = true;
    this.#abort.dispose();
    try {
      this.process.kill(9);
    } catch {}
  }
};
var ShimControl = class {
  static {
    __name(this, "ShimControl");
  }
  #reader;
  #session;
  #pending = /* @__PURE__ */ new Uint8Array();
  constructor(reader, session) {
    this.#reader = reader;
    this.#session = session;
  }
  async readFrame() {
    const header = await this.#readExactly(HEADER_LENGTH);
    validateHeader(header);
    const frameKind = header[5];
    const payloadLength = new DataView(header.buffer, header.byteOffset + 6, 4).getUint32(0, true);
    if (frameKind === FRAME_SUCCESS) {
      if (payloadLength !== 0) throw protocolError("sandbox-shim returned invalid control data");
      return { kind: "success" };
    }
    if (frameKind === FRAME_DATA)
      return {
        kind: "data",
        payload: await this.#readExactly(payloadLength),
      };
    if (frameKind !== FRAME_FILE_ERROR)
      throw protocolError(`sandbox-shim returned unknown control status ${frameKind}`);
    if (payloadLength < ERROR_PREFIX_LENGTH)
      throw protocolError("sandbox-shim returned invalid control data");
    if (payloadLength > 65540) throw protocolError("sandbox-shim error message exceeded its size limit");
    const payload = await this.#readExactly(payloadLength);
    const errno = new DataView(payload.buffer, payload.byteOffset, ERROR_PREFIX_LENGTH).getInt32(0, true);
    if (errno <= 0) throw protocolError(`sandbox-shim returned invalid errno ${errno}`);
    return {
      kind: "fileError",
      errno,
      detail: decodeErrorDetail(payload.subarray(ERROR_PREFIX_LENGTH)),
    };
  }
  async expectEnd() {
    if (
      !(
        this.#pending.length === 0
          ? await this.#session.waitFor(this.#reader.read())
          : {
              done: false,
              value: this.#pending,
            }
      ).done
    )
      throw protocolError("sandbox-shim returned trailing control data");
  }
  discard(reason) {
    this.#reader.cancel(reason).then(
      () => this.#reader.releaseLock(),
      () => this.#reader.releaseLock(),
    );
  }
  releaseLock() {
    this.#reader.releaseLock();
  }
  async #readExactly(length) {
    const result = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      if (this.#pending.length === 0) {
        const next = await this.#session.waitFor(this.#reader.read());
        if (next.done) throw protocolError("sandbox-shim returned truncated control data");
        this.#pending = next.value;
      }
      const count = Math.min(length - offset, this.#pending.length);
      result.set(this.#pending.subarray(0, count), offset);
      this.#pending = this.#pending.subarray(count);
      offset += count;
    }
    return result;
  }
};
function parseJsonPayload(payload, invalid) {
  try {
    const parsed = jsonSchema.safeParse(JSON.parse(jsonDecoder.decode(payload)));
    if (parsed.success) return parsed.data;
  } catch (cause) {
    throw protocolError(invalid, cause);
  }
  throw protocolError(invalid);
}
__name(parseJsonPayload, "parseJsonPayload");
function closeStdin$1(process) {
  process.stdin?.close().catch(() => void 0);
}
__name(closeStdin$1, "closeStdin$1");
function decodeErrorDetail(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw protocolError("sandbox-shim returned a non-UTF-8 error message", cause);
  }
}
__name(decodeErrorDetail, "decodeErrorDetail");
function validateHeader(header) {
  for (let index = 0; index < MAGIC.length; index += 1)
    if (header[index] !== MAGIC[index]) throw protocolError("sandbox-shim returned invalid protocol magic");
  if (header[4] !== PROTOCOL_VERSION)
    throw protocolError(`sandbox-shim protocol ${header[4]} is not supported`);
}
__name(validateHeader, "validateHeader");
var GATEWAY_HOST = "backups.sandbox.internal";
var ACKNOWLEDGEMENT = new Uint8Array([1]);
var messageSchema = object({ kind: string2() });
var errorSchema = object({
  kind: literal("error"),
  code: string2(),
  detail: string2(),
});
var lockedSchema = strictObject({ kind: literal("locked") });
var verifiedSchema = strictObject({ kind: literal("verified") });
async function runShimExchange(container, exchange) {
  const { signal } = exchange;
  signal?.throwIfAborted();
  const operation = exchange.command;
  const session = await ShimSession.start(
    container,
    [SHIM_PATH, "directory-backup", exchange.command, JSON.stringify(exchange.request)],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      signal,
    },
    "stdin",
  );
  let control;
  let input;
  let granting;
  let released = false;
  const release = /* @__PURE__ */ __name(async () => {
    if (released) return;
    released = true;
    if (granting !== void 0) {
      await granting.catch(() => void 0);
      await exchange.deny().catch(() => void 0);
    }
    if (input !== void 0) closeStdin(input);
  }, "release");
  try {
    control = session.openStdoutControl();
    input = session.openStdinWriter();
    const locked = await readMessage(control, operation, exchange.path);
    if (!lockedSchema.safeParse(locked).success)
      throw protocolError("sandbox-shim did not report that it holds the backup lock");
    granting = exchange.grant();
    await session.waitFor(granting);
    await session.waitFor(input.write(ACKNOWLEDGEMENT));
    if (exchange.command === "restore") {
      const verified = await readMessage(control, operation, exchange.path);
      if (!verifiedSchema.safeParse(verified).success)
        throw protocolError("sandbox-shim did not report a verified restore");
      signal?.throwIfAborted();
      session.stopFollowingSignal();
      await input.write(ACKNOWLEDGEMENT);
    }
    const result = await readMessage(control, operation, exchange.path);
    const done = exchange.done.safeParse(result);
    if (!done.success) throw protocolError("sandbox-shim returned an invalid backup result");
    await release();
    await control.expectEnd();
    const exitCode = await session.waitFor(session.process.exitCode);
    if (exitCode !== 0) throw protocolError(`sandbox-shim exited with code ${exitCode}`);
    control.releaseLock();
    return done.data;
  } catch (error) {
    await release();
    control?.discard(error);
    throw error;
  } finally {
    session.finish();
  }
}
__name(runShimExchange, "runShimExchange");
async function readMessage(control, operation, path) {
  const frame = await control.readFrame();
  if (frame.kind === "fileError")
    throw fileErrorFromErrno(
      {
        operation: operation === "backup" ? "backup" : "restore",
        path,
      },
      frame.errno,
      frame.detail,
    );
  if (frame.kind !== "data") throw protocolError("sandbox-shim did not return backup data");
  const value = parseJsonPayload(frame.payload, "sandbox-shim returned invalid backup data");
  if (!messageSchema.safeParse(value).success)
    throw protocolError("sandbox-shim returned invalid backup data");
  const failure2 = errorSchema.safeParse(value);
  if (failure2.success) throw shimFailure(failure2.data.code, failure2.data.detail, operation, path);
  return value;
}
__name(readMessage, "readMessage");
function shimFailure(code, detail, operation, path) {
  switch (code) {
    case "integrity":
      return backupError("BACKUP_INTEGRITY", operation, path, detail);
    case "notFound":
      return backupError("BACKUP_NOT_FOUND", operation, path, detail);
    case "transfer":
      return backupError("BACKUP_TRANSFER", operation, path, detail);
    case "protocol":
      return protocolError(detail);
    default:
      return protocolError(`sandbox-shim returned unknown backup error code "${code}"`);
  }
}
__name(shimFailure, "shimFailure");
function closeStdin(input) {
  input.close().catch(() => void 0);
}
__name(closeStdin, "closeStdin");
var absolutePath = string2().check(
  _startsWith("/"),
  refine((value) => !value.includes("\0")),
);
var SIGNAL = {
  schema: _instanceof(AbortSignal),
  requirement: "must be an AbortSignal",
};
var DIR = {
  schema: absolutePath,
  requirement: "must be an absolute path without NUL",
};
var BACKUP_OPTIONS = {
  dir: DIR,
  name: {
    schema: string2(),
    requirement: "must be a string",
  },
  exclude: {
    schema: array(string2()),
    requirement: "must be an array of strings",
  },
  gitignore: {
    schema: boolean2(),
    requirement: "must be a boolean",
  },
  signal: SIGNAL,
};
var RESTORE_OPTIONS = {
  dir: DIR,
  signal: SIGNAL,
};
var DELETE_OPTIONS = { signal: SIGNAL };
var sha256Schema = string2().check(_regex(/^[0-9a-f]{64}$/));
var recordSchema = object({
  id: string2().check(_regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)),
  dir: absolutePath,
  size: number2().check(refine((value) => Number.isSafeInteger(value) && value > 0)),
  name: optional(string2()),
  sha256: sha256Schema,
  format: literal(DIRECTORY_BACKUP_FORMAT),
});
var backupDoneSchema = strictObject({
  kind: literal("done"),
  size: number2().check(refine((value) => Number.isSafeInteger(value) && value > 0)),
  sha256: sha256Schema,
  parts: array(
    strictObject({
      partNumber: number2().check(int(), _positive()),
      etag: string2(),
    }),
  ).check(_minLength(1)),
});
var restoreDoneSchema = strictObject({ kind: literal("done") });
var DirectoryBackup = class {
  static {
    __name(this, "DirectoryBackup");
  }
  #container;
  #gateway;
  #binding;
  #prefix;
  constructor(container, gateway, storage) {
    if (!string2().check(_minLength(1)).safeParse(storage.binding).success)
      throw new TypeError("storage.binding must name an R2 bucket binding");
    const prefix = storage.prefix ?? "";
    if (!string2().safeParse(prefix).success || (prefix !== "" && !prefix.endsWith("/")))
      throw new TypeError('storage.prefix must be a string that ends in "/"');
    this.#container = container;
    this.#gateway = gateway;
    this.#binding = storage.binding;
    this.#prefix = prefix;
  }
  /**
   * Routes the Container's backup traffic to `DirectoryBackupGateway`, which refuses every
   * request until an operation starts. Backups and restores do this themselves; call it only
   * when the Durable Object also registers `interceptAllOutboundHttp()`, which takes every
   * hostname registered after it. Call it right after starting the Container and before the
   * catch-all, never while an operation may be running: it would replace that operation's
   * grant. It does not start the Container.
   */
  intercept() {
    return this.#deny();
  }
  /**
   * Backs up `dir` and returns its record. Pause writers in `dir` first: files that change
   * while it's read are captured as they are at that moment.
   *
   * @throws {SandboxFileError} `dir` is missing or not a directory, a file can't be read, or an
   *   exclude pattern is invalid (`EINVAL`).
   * @throws {SandboxBackupError} `BACKUP_TRANSFER` when a part upload fails, or
   *   `BACKUP_INTEGRITY` when R2 stored a different size than was uploaded.
   */
  async backup(options) {
    validateOptions(options, BACKUP_OPTIONS);
    if (options.dir === void 0) throw new TypeError("dir must be an absolute path without NUL");
    const { dir, name, signal } = options;
    const id = crypto.randomUUID();
    const control = this.#control(this.#key(id));
    const { uploadId, done } = await this.#upload(control, this.#key(id), options);
    let size;
    try {
      signal?.throwIfAborted();
      size = await control.completeUpload(uploadId, done.parts);
    } catch (error) {
      await control.abortUpload(uploadId).catch(() => void 0);
      throw error;
    }
    if (size !== done.size) {
      await control.deleteObject().catch(() => void 0);
      throw backupError(
        "BACKUP_INTEGRITY",
        "backup",
        dir,
        `R2 stored ${size} bytes, but the container uploaded ${done.size}`,
      );
    }
    const record2 = {
      id,
      dir,
      size,
      sha256: done.sha256,
      format: DIRECTORY_BACKUP_FORMAT,
    };
    return name === void 0
      ? record2
      : {
          ...record2,
          name,
        };
  }
  /**
   * Replaces `options.dir`, or the record's `dir`, with the backup's contents. The directory is
   * extracted beside the target and swapped in only after the download is verified. A
   * `SandboxFileError` or `SandboxBackupError` means the target was not replaced, and so does
   * an abort before the download is verified; after that, aborting no longer ends the call. If the
   * connection to the Container is lost, as when the Durable Object restarts, the target may or
   * may not have been replaced, and restoring again settles it. The target's parent must exist;
   * the target need not.
   *
   * @throws {SandboxFileError} The target's parent is missing (`ENOENT`), the target isn't a
   *   directory (`ENOTDIR`), is a mount point or has one inside it (`EBUSY`), the swap fails (for
   *   example `EXDEV`), or the disk fills (`ENOSPC`).
   * @throws {SandboxBackupError} `BACKUP_NOT_FOUND`, `BACKUP_INTEGRITY`, or `BACKUP_TRANSFER`.
   */
  async restore(backup, options = {}) {
    validateOptions(options, RESTORE_OPTIONS);
    const record2 = parseRecord(backup);
    const dir = options.dir ?? record2.dir;
    const key = this.#key(record2.id);
    await runShimExchange(this.#container, {
      command: "restore",
      request: {
        gateway: GATEWAY_HOST,
        dir,
        size: record2.size,
        sha256: record2.sha256,
      },
      path: dir,
      signal: options.signal,
      done: restoreDoneSchema,
      grant: /* @__PURE__ */ __name(
        () =>
          this.#register({
            protocolVersion: 1,
            mode: "read",
            binding: this.#binding,
            key,
          }),
        "grant",
      ),
      deny: /* @__PURE__ */ __name(() => this.#deny(), "deny"),
    });
  }
  /**
   * Deletes the backup's object. Needs no running Container. Deleting an object that is already
   * gone succeeds. A restore reading it at the same time fails, and nothing is swapped.
   */
  async delete(backup, options = {}) {
    validateOptions(options, DELETE_OPTIONS);
    const record2 = parseRecord(backup);
    options.signal?.throwIfAborted();
    await this.#control(this.#key(record2.id)).deleteObject();
  }
  /**
   * Runs the shim's backup into a new multipart upload, which its grant creates once the shim
   * holds the lock. Aborts the upload if the backup fails.
   */
  async #upload(control, key, options) {
    const { dir } = options;
    let uploadId;
    try {
      const done = await runShimExchange(this.#container, {
        command: "backup",
        request: {
          gateway: GATEWAY_HOST,
          dir,
          exclude: [...(options.exclude ?? [])],
          gitignore: options.gitignore ?? false,
        },
        path: dir,
        signal: options.signal,
        done: backupDoneSchema,
        grant: /* @__PURE__ */ __name(async () => {
          uploadId = await control.createUpload(options.name);
          await this.#register({
            protocolVersion: 1,
            mode: "write",
            binding: this.#binding,
            key,
            uploadId,
          });
        }, "grant"),
        deny: /* @__PURE__ */ __name(() => this.#deny(), "deny"),
      });
      if (uploadId === void 0) throw new Error("the backup finished without an upload");
      return {
        uploadId,
        done,
      };
    } catch (error) {
      if (uploadId !== void 0) await control.abortUpload(uploadId).catch(() => void 0);
      throw error;
    }
  }
  #key(id) {
    return `${this.#prefix}${id}.tar.zst`;
  }
  #control(key) {
    return this.#gateway({
      props: {
        protocolVersion: 1,
        mode: "control",
        binding: this.#binding,
        key,
      },
    });
  }
  #register(props) {
    return this.#container.interceptOutboundHttp(GATEWAY_HOST, this.#gateway({ props }));
  }
  #deny() {
    return this.#register({
      protocolVersion: 1,
      mode: "deny",
    });
  }
};
function parseRecord(backup) {
  const parsed = recordSchema.safeParse(backup);
  if (!parsed.success)
    throw new TypeError(`backup must be a directory backup record in format "${DIRECTORY_BACKUP_FORMAT}"`);
  return parsed.data;
}
__name(parseRecord, "parseRecord");
function startFileCommand(container, command, stdio) {
  const { cwd, user, signal } = command.options;
  const execOptions = { ...stdio };
  if (user !== void 0) execOptions.user = user;
  if (signal !== void 0) execOptions.signal = signal;
  const paths = command.paths.map((path) => resolvePath(path, cwd));
  return ShimSession.start(
    container,
    [SHIM_PATH, command.name, ...paths, ...(command.flags ?? [])],
    execOptions,
  );
}
__name(startFileCommand, "startFileCommand");
function resolvePath(path, cwd) {
  return cwd === void 0 || path.startsWith("/") ? path : `${cwd}/${path}`;
}
__name(resolvePath, "resolvePath");
async function runFileCommand(container, request) {
  const session = await startFileCommand(container, request, {
    stdout: "pipe",
    stderr: "ignore",
  });
  let control;
  try {
    control = session.openStdoutControl();
    const frame = await control.readFrame();
    await control.expectEnd();
    if (frame.kind === "fileError") {
      await session.settle();
      throw fileErrorFromErrno(request.error, frame.errno, frame.detail);
    }
    if (frame.kind !== request.expected)
      throw protocolError(
        request.expected === "data"
          ? "sandbox-shim did not return command data"
          : "sandbox-shim did not confirm command completion",
      );
    const exitCode = await session.waitFor(session.process.exitCode);
    if (exitCode !== 0) throw protocolError(`sandbox-shim exited with code ${exitCode}`);
    control.releaseLock();
    session.finish();
    return frame.kind === "data" ? frame.payload : void 0;
  } catch (error) {
    session.terminate();
    control?.discard(error);
    throw error;
  }
}
__name(runFileCommand, "runFileCommand");
function fileContentStream(content) {
  if (content instanceof ReadableStream) return content;
  if (content instanceof Blob) return content.stream();
  let bytes;
  if (typeof content === "string") bytes = new TextEncoder().encode(content);
  else if (content instanceof ArrayBuffer) bytes = new Uint8Array(content);
  else {
    bytes = new Uint8Array(content.byteLength);
    bytes.set(new Uint8Array(content.buffer, content.byteOffset, content.byteLength));
  }
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
__name(fileContentStream, "fileContentStream");
function decodeFileType(value) {
  switch (value) {
    case 0:
      return "file";
    case 1:
      return "directory";
    case 2:
      return "symlink";
    case 3:
      return "blockDevice";
    case 4:
      return "characterDevice";
    case 5:
      return "fifo";
    case 6:
      return "socket";
    default:
      throw protocolError("sandbox-shim returned an unknown file type");
  }
}
__name(decodeFileType, "decodeFileType");
async function readDirectory(container, path, options) {
  return decodeEntries(
    await runFileCommand(container, {
      name: "read-directory",
      paths: [path],
      options,
      error: {
        operation: "readDirectory",
        path,
      },
      expected: "data",
    }),
  );
}
__name(readDirectory, "readDirectory");
function decodeEntries(payload) {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let offset = 0;
  const count = readUint32(view, offset);
  offset += 4;
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const type = decodeFileType(readByte(payload, offset));
    offset += 1;
    const nameLength = readUint16(view, offset);
    offset += 2;
    const name = decodeText(readBytes(payload, offset, nameLength));
    offset += nameLength;
    entries.push({
      name,
      type,
    });
  }
  if (offset !== payload.length) throw protocolError("sandbox-shim returned trailing directory data");
  return entries;
}
__name(decodeEntries, "decodeEntries");
function readByte(payload, offset) {
  const value = payload[offset];
  if (value === void 0) throw protocolError("sandbox-shim returned truncated directory data");
  return value;
}
__name(readByte, "readByte");
function readUint16(view, offset) {
  if (offset + 2 > view.byteLength) throw protocolError("sandbox-shim returned truncated directory data");
  return view.getUint16(offset, true);
}
__name(readUint16, "readUint16");
function readUint32(view, offset) {
  if (offset + 4 > view.byteLength) throw protocolError("sandbox-shim returned truncated directory data");
  return view.getUint32(offset, true);
}
__name(readUint32, "readUint32");
function readBytes(payload, offset, length) {
  if (offset + length > payload.length) throw protocolError("sandbox-shim returned truncated directory data");
  return payload.subarray(offset, offset + length);
}
__name(readBytes, "readBytes");
function decodeText(bytes) {
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch (cause) {
    throw protocolError("sandbox-shim returned invalid UTF-8 in directory entry name", cause);
  }
}
__name(decodeText, "decodeText");
async function readFile(container, path, options) {
  const session = await startFileCommand(
    container,
    {
      name: "read",
      paths: [path],
      options,
    },
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let control;
  let stdout;
  try {
    control = session.openStderrControl();
    stdout = new StdoutReader(session.openStdoutReader());
    const opening = await control.readFrame();
    stdout.stopReadingAhead();
    if (opening.kind === "fileError") {
      await control.expectEnd();
      await session.settle();
      throw fileErrorFromErrno(
        {
          operation: "readFile",
          path,
        },
        opening.errno,
        opening.detail,
      );
    }
    if (opening.kind !== "success") throw protocolError("sandbox-shim returned data before file bytes");
    const terminal = readTerminalControl(control);
    terminal.catch(() => void 0);
    return new Response(responseBody(session, control, stdout, terminal, path));
  } catch (error) {
    terminateRead(session, control, stdout, error);
    throw error;
  }
}
__name(readFile, "readFile");
var StdoutReader = class {
  static {
    __name(this, "StdoutReader");
  }
  #reader;
  #chunks = [];
  #pending;
  #readingAhead = true;
  constructor(reader) {
    this.#reader = reader;
    this.#readNext();
  }
  /** Stops reading ahead. Chunks already read stay queued for `read()`. */
  stopReadingAhead() {
    this.#readingAhead = false;
  }
  read() {
    const chunk = this.#chunks.shift();
    if (chunk !== void 0)
      return Promise.resolve({
        done: false,
        value: chunk,
      });
    const pending = this.#pending ?? this.#reader.read();
    this.#pending = void 0;
    return pending;
  }
  discard(reason) {
    this.#reader.cancel(reason).then(
      () => this.#reader.releaseLock(),
      () => this.#reader.releaseLock(),
    );
  }
  releaseLock() {
    this.#reader.releaseLock();
  }
  #readNext() {
    const read = this.#reader.read();
    this.#pending = read;
    read.then(
      (result) => {
        if (this.#pending !== read || result.done) return;
        this.#pending = void 0;
        this.#chunks.push(result.value);
        if (this.#readingAhead) this.#readNext();
      },
      () => void 0,
    );
  }
};
function responseBody(session, control, stdout, terminalFrame, path) {
  return new ReadableStream({
    pull: /* @__PURE__ */ __name(async (controller) => {
      try {
        const next = await session.waitFor(stdout.read());
        if (!next.done) {
          controller.enqueue(next.value);
          return;
        }
        const terminal = await session.waitFor(terminalFrame);
        if (terminal.kind === "fileError") {
          await session.settle();
          throw fileErrorFromErrno(
            {
              operation: "readFile",
              path,
            },
            terminal.errno,
            terminal.detail,
          );
        }
        if (terminal.kind !== "success") throw protocolError("sandbox-shim returned data after file bytes");
        stdout.releaseLock();
        control.releaseLock();
        session.finish();
        controller.close();
      } catch (error) {
        terminateRead(session, control, stdout, error);
        controller.error(error);
      }
    }, "pull"),
    cancel: /* @__PURE__ */ __name((reason) => terminateRead(session, control, stdout, reason), "cancel"),
  });
}
__name(responseBody, "responseBody");
async function readTerminalControl(control) {
  const frame = await control.readFrame();
  await control.expectEnd();
  return frame;
}
__name(readTerminalControl, "readTerminalControl");
function terminateRead(session, control, stdout, reason) {
  session.terminate();
  control?.discard(reason);
  stdout?.discard(reason);
}
__name(terminateRead, "terminateRead");
var STAT_PAYLOAD_LENGTH = 45;
async function statFile(container, path, options, operation) {
  const payload = await runFileCommand(container, {
    name: operation,
    paths: [path],
    options,
    error: {
      operation,
      path,
    },
    expected: "data",
  });
  if (payload.length !== STAT_PAYLOAD_LENGTH)
    throw protocolError(`sandbox-shim returned invalid ${operation} data`);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    type: decodeFileType(payload[0]),
    size: view.getBigUint64(1, true),
    mode: view.getUint32(9, true),
    uid: view.getUint32(13, true),
    gid: view.getUint32(17, true),
    accessedAt: decodeDate(view.getBigInt64(21, true)),
    modifiedAt: decodeDate(view.getBigInt64(29, true)),
    changedAt: decodeDate(view.getBigInt64(37, true)),
  };
}
__name(statFile, "statFile");
function decodeDate(milliseconds) {
  const value = Number(milliseconds);
  if (!Number.isSafeInteger(value)) throw protocolError("sandbox-shim returned an out-of-range timestamp");
  const date2 = new Date(value);
  if (Number.isNaN(date2.valueOf())) throw protocolError("sandbox-shim returned an out-of-range timestamp");
  return date2;
}
__name(decodeDate, "decodeDate");
async function writeFile(container, path, source, options) {
  let session;
  let control;
  let input;
  let sourceReader;
  try {
    session = await startFileCommand(
      container,
      {
        name: "write",
        paths: [path],
        options,
      },
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    control = session.openStdoutControl();
    input = session.openStdinWriter();
    const opening = await control.readFrame();
    if (opening.kind === "fileError") {
      await control.expectEnd();
      await session.settle();
    }
    expectSuccess(opening, path);
    sourceReader = source.getReader();
    const pumping = pumpSource(session, sourceReader, input);
    const terminal = terminalResult(session, control);
    const first = await Promise.race([pumping, terminal]);
    if (first.kind === "frame" || first.kind === "failure") {
      handleTerminal(first, path);
      handlePump(await pumping);
    } else if (first.kind === "sourceFailure") throw first.error;
    else if (first.kind === "inputFailure") {
      const result = await terminal;
      if (result.kind === "frame" && result.frame.kind === "fileError") expectSuccess(result.frame, path);
      if (result.kind === "failure") throw result.error;
      throw first.error;
    } else handleTerminal(await terminal, path);
    const exitCode = await session.waitFor(session.process.exitCode);
    if (exitCode !== 0) throw protocolError(`sandbox-shim exited with code ${exitCode}`);
    sourceReader.releaseLock();
    input.releaseLock();
    control.releaseLock();
    session.finish();
  } catch (error) {
    session?.terminate();
    if (input !== void 0) discardInput(input, error);
    control?.discard(error);
    if (sourceReader === void 0) source.cancel(error).catch(() => void 0);
    else discardSource(sourceReader, error);
    throw error;
  }
}
__name(writeFile, "writeFile");
async function pumpSource(session, source, input) {
  while (true) {
    try {
      await session.waitFor(input.ready);
    } catch (error) {
      return {
        kind: "inputFailure",
        error,
      };
    }
    let next;
    try {
      next = await session.waitFor(source.read());
    } catch (error) {
      return {
        kind: "sourceFailure",
        error,
      };
    }
    if (next.done)
      try {
        await session.waitFor(input.close());
        return { kind: "complete" };
      } catch (error) {
        return {
          kind: "inputFailure",
          error,
        };
      }
    if (!(next.value instanceof Uint8Array))
      return {
        kind: "sourceFailure",
        error: /* @__PURE__ */ new TypeError("writeFile stream chunks must be Uint8Array values"),
      };
    try {
      await session.waitFor(input.write(next.value));
    } catch (error) {
      return {
        kind: "inputFailure",
        error,
      };
    }
  }
}
__name(pumpSource, "pumpSource");
async function terminalResult(session, control) {
  try {
    const frame = await control.readFrame();
    await control.expectEnd();
    if (frame.kind === "fileError") await session.settle();
    return {
      kind: "frame",
      frame,
    };
  } catch (error) {
    return {
      kind: "failure",
      error,
    };
  }
}
__name(terminalResult, "terminalResult");
function handleTerminal(result, path) {
  if (result.kind === "failure") throw result.error;
  expectSuccess(result.frame, path);
}
__name(handleTerminal, "handleTerminal");
function handlePump(result) {
  if (result.kind !== "complete") throw result.error;
}
__name(handlePump, "handlePump");
function expectSuccess(frame, path) {
  if (frame.kind === "fileError")
    throw fileErrorFromErrno(
      {
        operation: "writeFile",
        path,
      },
      frame.errno,
      frame.detail,
    );
  if (frame.kind !== "success") throw protocolError("sandbox-shim returned data while writing a file");
}
__name(expectSuccess, "expectSuccess");
function discardInput(input, reason) {
  input.abort(reason).then(
    () => input.releaseLock(),
    () => input.releaseLock(),
  );
}
__name(discardInput, "discardInput");
function discardSource(source, reason) {
  source.cancel(reason).then(
    () => source.releaseLock(),
    () => source.releaseLock(),
  );
}
__name(discardSource, "discardSource");
var FLAG = {
  schema: boolean2(),
  requirement: "must be a boolean",
};
var FILE_OPTIONS = {
  cwd: {
    schema: string2().check(_startsWith("/")),
    requirement: "must be an absolute path",
  },
  user: {
    schema: string2().check(_regex(/^[0-9]+:[0-9]+$/)),
    requirement: 'must be numeric user and group IDs, as "uid:gid"',
  },
  signal: {
    schema: _instanceof(AbortSignal),
    requirement: "must be an AbortSignal",
  },
};
var MKDIR_OPTIONS = {
  ...FILE_OPTIONS,
  recursive: FLAG,
};
var REMOVE_OPTIONS = {
  ...FILE_OPTIONS,
  recursive: FLAG,
  force: FLAG,
};
var Files = class {
  static {
    __name(this, "Files");
  }
  #container;
  constructor(container) {
    this.#container = container;
  }
  /**
   * Streams bytes from a path in the running container using native Linux file semantics.
   *
   * Native container, transport, and abort failures propagate unchanged.
   *
   * @param path - Absolute path, or a relative path when `options.cwd` is provided.
   * @param options - Native execution options relevant to opening the file.
   * @returns A binary response whose body applies backpressure to the container process. A
   *   file-streaming or native transport failure can surface while the body is consumed.
   * @throws {TypeError} The path is empty, contains NUL, or is relative without `cwd`, or an
   *   option is unknown or invalid.
   * @throws {SandboxFileError} The container reports a filesystem failure before returning the
   *   response. A late file-streaming failure errors the response body with the same error type.
   * @throws {SandboxProtocolError} The package and `sandbox-shim` cannot complete their protocol.
   */
  async readFile(path, options = {}) {
    validateOptions(options, FILE_OPTIONS);
    validatePath(path, options.cwd);
    return readFile(this.#container, path, options);
  }
  /**
   * Creates or truncates a file and streams content into it using native Linux semantics.
   *
   * The destination is opened before a caller-provided stream is consumed. Failures after that
   * point can leave a created, truncated, or partially written file. Native container, transport,
   * source-stream, and abort failures propagate unchanged.
   *
   * @throws {TypeError} The path is empty, contains NUL, or is relative without an absolute `cwd`,
   *   or an option is unknown or invalid.
   * @throws {SandboxFileError} The container reports a filesystem failure.
   * @throws {SandboxProtocolError} The package and `sandbox-shim` cannot complete their protocol.
   */
  async writeFile(path, content, options = {}) {
    validateOptions(options, FILE_OPTIONS);
    validatePath(path, options.cwd);
    await writeFile(this.#container, path, fileContentStream(content), options);
  }
  /**
   * Returns metadata for a path using native Linux filesystem semantics.
   *
   * Native container, transport, and abort failures propagate unchanged.
   *
   * @throws {TypeError} The path is empty, contains NUL, or is relative without an absolute `cwd`,
   *   or an option is unknown or invalid.
   * @throws {SandboxFileError} The container reports a filesystem failure.
   * @throws {SandboxProtocolError} The package and `sandbox-shim` cannot complete their protocol.
   */
  async stat(path, options = {}) {
    validateOptions(options, FILE_OPTIONS);
    validatePath(path, options.cwd);
    return statFile(this.#container, path, options, "stat");
  }
  /**
   * Returns metadata for a path without following its final symlink.
   *
   * Native container, transport, and abort failures propagate unchanged.
   *
   * @throws {TypeError} The path is empty, contains NUL, or is relative without an absolute `cwd`,
   *   or an option is unknown or invalid.
   * @throws {SandboxFileError} The container reports a filesystem failure.
   * @throws {SandboxProtocolError} The package and `sandbox-shim` cannot complete their protocol.
   */
  async lstat(path, options = {}) {
    validateOptions(options, FILE_OPTIONS);
    validatePath(path, options.cwd);
    return statFile(this.#container, path, options, "lstat");
  }
  /**
   * Returns the immediate entries from a directory in native enumeration order.
   *
   * The directory path may resolve through a symlink, but entry types describe the entries
   * themselves and do not follow symlinks. The operation does not recurse or retrieve metadata
   * for each child.
   * Native container, transport, and abort failures propagate unchanged.
   *
   * @throws {TypeError} The path is empty, contains NUL, or is relative without an absolute `cwd`,
   *   or an option is unknown or invalid.
   * @throws {SandboxFileError} The container reports a filesystem failure.
   * @throws {SandboxProtocolError} The package and `sandbox-shim` cannot complete their protocol.
   */
  async readDirectory(path, options = {}) {
    validateOptions(options, FILE_OPTIONS);
    validatePath(path, options.cwd);
    return readDirectory(this.#container, path, options);
  }
  /**
   * Creates a directory using native Linux filesystem semantics.
   *
   * By default only the final directory is created. With `recursive`, missing parents are
   * created and an existing target directory is accepted. Partial parent creation can remain
   * after failure or cancellation.
   * Native container, transport, and abort failures propagate unchanged.
   *
   * @throws {TypeError} The path is empty, contains NUL, or is relative without an absolute `cwd`,
   *   or an option is unknown or invalid.
   * @throws {SandboxFileError} The container reports a filesystem failure.
   * @throws {SandboxProtocolError} The package and `sandbox-shim` cannot complete their protocol.
   */
  async mkdir(path, options = {}) {
    validateOptions(options, MKDIR_OPTIONS);
    validatePath(path, options.cwd);
    await runFileCommand(this.#container, {
      name: "mkdir",
      paths: [path],
      flags: options.recursive ? ["--recursive"] : [],
      options,
      error: {
        operation: "mkdir",
        path,
      },
      expected: "success",
    });
  }
  /**
   * Renames a file, directory, or symlink using native Linux filesystem semantics.
   *
   * Existing destinations are replaced when Linux permits it. Cross-filesystem renames fail
   * with `EXDEV`; no copy-and-remove fallback is attempted.
   * Native container, transport, and abort failures propagate unchanged.
   *
   * @throws {TypeError} A path is empty, contains NUL, or is relative without an absolute `cwd`,
   *   or an option is unknown or invalid.
   * @throws {SandboxFileError} The container reports a filesystem failure.
   * @throws {SandboxProtocolError} The package and `sandbox-shim` cannot complete their protocol.
   */
  async rename(source, destination, options = {}) {
    validateOptions(options, FILE_OPTIONS);
    validatePath(source, options.cwd);
    validatePath(destination, options.cwd);
    await runFileCommand(this.#container, {
      name: "rename",
      paths: [source, destination],
      options,
      error: {
        operation: "rename",
        path: source,
        destination,
      },
      expected: "success",
    });
  }
  /**
   * Removes a file or symlink using native Linux filesystem semantics.
   *
   * Directories are rejected unless `recursive` is set. Recursive removal does not follow
   * symlinks and can leave partial effects after failure or cancellation. `force` ignores only
   * a missing target. Native container, transport, and abort failures propagate unchanged.
   *
   * @throws {TypeError} The path is empty, contains NUL, or is relative without an absolute `cwd`,
   *   or an option is unknown or invalid.
   * @throws {SandboxFileError} The container reports a filesystem failure.
   * @throws {SandboxProtocolError} The package and `sandbox-shim` cannot complete their protocol.
   */
  async remove(path, options = {}) {
    validateOptions(options, REMOVE_OPTIONS);
    validatePath(path, options.cwd);
    const flags = [];
    if (options.recursive) flags.push("--recursive");
    if (options.force) flags.push("--force");
    await runFileCommand(this.#container, {
      name: "remove",
      paths: [path],
      flags,
      options,
      error: {
        operation: "remove",
        path,
      },
      expected: "success",
    });
  }
};
function validatePath(path, cwd) {
  if (typeof path !== "string") throw new TypeError("path must be a string");
  if (path.length === 0) throw new TypeError("path must not be empty");
  if (path.includes("\0")) throw new TypeError("path cannot contain NUL characters");
  if (!path.startsWith("/") && cwd === void 0) throw new TypeError("cwd is required when path is relative");
}
__name(validatePath, "validatePath");
var decoder = new TextDecoder("utf-8", { fatal: true });
var credentialResponseSchema = strictObject({
  accessKeyId: string2().check(_minLength(1), _regex(/^[^\0]+$/)),
  secretAccessKey: string2().check(_minLength(1), _regex(/^[^\0]+$/)),
  sessionToken: optional(string2().check(_minLength(1), _regex(/^[^\0]+$/))),
  expiresAt: number2().check(int()),
});
var objectSchema = object({});
var stringSchema = string2();
var fetcherSchema = object({ fetch: _function() });
var finiteNumberSchema = number2().check(refine(Number.isFinite));
var ROUTE_READY = new Uint8Array([1]);
var routeIdSchema = string2().check(_regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,58}[A-Za-z0-9])?$/));
var keyPrefixSchema = optional(string2().check(refine((value) => value.endsWith("/"))));
var s3fsOptionSchema = object({
  name: string2(),
  value: optional(string2()),
});
var observedConfigurationSchema = object({
  source: object({
    type: literal("s3"),
    endpoint: string2(),
    region: string2(),
    bucket: string2(),
  }),
  keyPrefix: keyPrefixSchema,
  access: union([literal("read-only"), literal("read-write")]),
  s3fsOptions: array(s3fsOptionSchema),
});
var markerSchema = object({
  protocolVersion: literal(1),
  routeId: routeIdSchema,
  mountPath: string2(),
  configuration: observedConfigurationSchema,
});
var fuseSchema = discriminatedUnion("status", [
  object({ status: literal("connected") }),
  object({ status: literal("disconnected") }),
  object({
    status: literal("indeterminate"),
    detail: string2(),
  }),
]);
var guestStateSchema = discriminatedUnion("kind", [
  object({ kind: literal("absent") }),
  object({
    kind: literal("unmanaged"),
    filesystemType: string2(),
  }),
  object({
    kind: literal("incompatible"),
    protocolVersion: number2().check(int()),
  }),
  object({
    kind: literal("stale"),
    marker: markerSchema,
  }),
  object({
    kind: literal("managed"),
    marker: markerSchema,
    fuse: fuseSchema,
  }),
]);
var gatewayStateSchema = discriminatedUnion("kind", [
  object({
    kind: literal("gatewayUnreachable"),
    detail: string2(),
  }),
  object({
    kind: literal("gatewayError"),
    reason: union([literal("credential-provider"), literal("protocol"), literal("internal")]),
    detail: string2(),
  }),
  object({ kind: literal("usable") }),
  object({
    kind: literal("upstreamUnavailable"),
    detail: string2(),
  }),
  object({
    kind: literal("upstreamRejected"),
    reason: union([literal("credentials"), literal("access"), literal("not-found"), literal("other")]),
    detail: string2(),
  }),
]);
var inspectionEvidenceSchema = object({
  state: guestStateSchema,
  gateway: optional(gatewayStateSchema),
});
var envelopeSchema = discriminatedUnion("ok", [
  object({
    ok: literal(true),
    value: json(),
  }),
  object({
    ok: literal(false),
    error: object({
      kind: string2(),
      detail: string2(),
    }),
  }),
]);
var routeSelectionSchema = object({
  kind: literal("route"),
  routeId: routeIdSchema,
});

// src/policy.ts
var INTERCEPT_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
var IDLE_MS = 15 * 6e4;
var ALARM_MS = 6e4;
var MAX_JOB_SECONDS = 60 * 60;
var MAX_EXEC_SECONDS = 120;
var MAX_EXEC_OUTPUT_BYTES = 4 * 1024 * 1024;
var MAX_LOG_CHUNK_BYTES = 1024 * 1024;
var MAX_TOKEN_TTL_SECONDS = 2 * 60 * 60;
var JOBS_DIR = "/var/lib/teire/jobs";
var WORK_DIR = "/work";
var REGISTRY_HOSTS = /* @__PURE__ */ new Set([
  // npm, pnpm, yarn (corepack downloads the package managers from these too)
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "repo.yarnpkg.com",
  // Python
  "pypi.org",
  "files.pythonhosted.org",
  // JVM
  "repo.maven.apache.org",
  "repo1.maven.org",
  "maven-central.storage-download.googleapis.com",
  "plugins.gradle.org",
  "services.gradle.org",
  "dl.google.com",
  "maven.google.com",
  // Go
  "proxy.golang.org",
  "sum.golang.org",
  // Rust
  "index.crates.io",
  "static.crates.io",
  "crates.io",
  "static.rust-lang.org",
  // Ruby
  "rubygems.org",
  "index.rubygems.org",
  // Toolchain and release downloads redirected from github.com
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);
var BASE_ENV = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/root",
  CI: "1",
  NODE_EXTRA_CA_CERTS: INTERCEPT_CA,
  SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
  CURL_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
  GIT_SSL_CAINFO: "/etc/ssl/certs/ca-certificates.crt",
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  npm_config_update_notifier: "false",
  npm_config_fund: "false",
  npm_config_audit: "false",
};
var SANDBOX_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
var JOB_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

// src/index.ts
var Egress = class extends WorkerEntrypoint2 {
  static {
    __name(this, "Egress");
  }
  async fetch(request) {
    const { sid, phase, tarball } = this.ctx.props;
    const url = new URL(request.url);
    const read = request.method === "GET" || request.method === "HEAD";
    if (tarball && read && request.url === tarball.url) {
      const headers = new Headers({ "user-agent": "teire-sandbox" });
      if (tarball.token) headers.set("authorization", `Bearer ${tarball.token}`);
      return fetch(request.url, { headers, redirect: "follow" });
    }
    if (phase === "install" && read && url.protocol === "https:" && REGISTRY_HOSTS.has(url.hostname)) {
      return fetch(request);
    }
    const event = {
      at: Date.now(),
      phase,
      method: request.method,
      host: url.hostname,
      path: url.pathname.slice(0, 200),
    };
    this.ctx.waitUntil(sandboxStub(this.env, sid).recordEgress(event));
    return new Response("teire-sandbox: egress denied\n", {
      status: 403,
      headers: { "x-teire-egress": "denied" },
    });
  }
};
var decoder2 = new TextDecoder();
var VerifySandbox = class extends DurableObject {
  static {
    __name(this, "VerifySandbox");
  }
  #container;
  #files;
  #backups;
  constructor(ctx, env) {
    super(ctx, env);
    if (!ctx.container) throw new Error("No container is configured for VerifySandbox");
    this.#container = ctx.container;
    this.#files = new Files(this.#container);
    this.#backups = new DirectoryBackup(this.#container, ctx.exports.DirectoryBackupGateway, {
      binding: "DEP_CACHE",
      prefix: "deps/",
    });
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS egress (at INTEGER, phase TEXT, method TEXT, host TEXT, path TEXT)",
    );
    if (this.#container.running) {
      void ctx.blockConcurrencyWhile(() => this.#container.setInactivityTimeout(IDLE_MS));
    }
  }
  async start(sid, options) {
    if (this.#container.running) throw new Error("conflict: sandbox already running");
    const started = Date.now();
    const instance = options.instance ?? "standard-2";
    const labels = { sid };
    if (options.snapshotId) {
      this.#container.start({
        containerSnapshot: { id: options.snapshotId },
        enableInternet: false,
        instance,
        labels,
      });
    } else {
      const image = this.#container.images[options.image ?? "node"];
      if (!image) throw new Error(`unknown image: ${options.image}`);
      this.#container.start({ image, enableInternet: false, instance, labels });
    }
    await this.#container.setInactivityTimeout(IDLE_MS);
    await this.ctx.storage.put("sid", sid);
    await this.#backups.intercept();
    await this.#routeEgress(sid, "install", options.snapshotId ? void 0 : options.tarball);
    const trust = await this.#trustInterceptCa();
    if (trust.exitCode !== 0) throw new Error(`could not trust the intercept CA: ${trust.stderr}`);
    let fetchMs = 0;
    if (!options.snapshotId && options.tarball) {
      const fetched = await this.#run(
        [
          "bash",
          "-c",
          'mkdir -p "$1" && curl -fsSL "$0" | tar -xz --strip-components=1 -C "$1"',
          options.tarball.url,
          WORK_DIR,
        ],
        { timeoutSec: 300 },
      );
      if (fetched.exitCode !== 0) throw new Error(`tarball fetch failed: ${fetched.stderr.slice(0, 500)}`);
      fetchMs = fetched.ms;
      await this.#routeEgress(sid, "install");
    }
    return { sid, instance, startMs: Date.now() - started, fetchMs };
  }
  /** Switches between the install (registries only) and check (nothing) phases without a restart. */
  async setPhase(phase) {
    const sid = await this.#sid();
    await this.#routeEgress(sid, phase);
    await this.ctx.storage.put("phase", phase);
    return { phase };
  }
  async startJob(jobId, argv, options) {
    if (!JOB_ID.test(jobId)) throw new Error("bad request: invalid job id");
    if (argv.length === 0) throw new Error("bad request: empty argv");
    const dir = `${JOBS_DIR}/${jobId}`;
    const made = await this.#run(["mkdir", "-p", JOBS_DIR], {}).then(() => this.#run(["mkdir", dir], {}));
    if (made.exitCode !== 0) throw new Error("conflict: job id already used");
    const timeoutSec = Math.min(options.timeoutSec ?? 600, MAX_JOB_SECONDS);
    await this.#container.exec(
      ["teire-job", dir, String(timeoutSec), options.cwd ?? WORK_DIR, "--", ...argv],
      {
        env: { ...BASE_ENV, ...options.env },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    let status = await this.jobStatus(jobId);
    for (let i = 0; i < 50 && status.state === "starting"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      status = await this.jobStatus(jobId);
    }
    await this.ctx.storage.put(`job:${jobId}`, { startedAt: Date.now(), timeoutSec });
    await this.#ensureAlarm();
    return status;
  }
  async jobStatus(jobId) {
    if (!JOB_ID.test(jobId)) throw new Error("bad request: invalid job id");
    const out = await this.#run(["teire-job-status", `${JOBS_DIR}/${jobId}`], {});
    return JSON.parse(out.stdout.trim() || '{"state":"missing"}');
  }
  /** Bytes of a job's log from `offset`, at most MAX_LOG_CHUNK_BYTES. */
  async jobLog(jobId, stream, offset) {
    if (!JOB_ID.test(jobId)) throw new Error("bad request: invalid job id");
    const file = `${JOBS_DIR}/${jobId}/${stream}.log`;
    const proc = await this.#container.exec(
      [
        "bash",
        "-c",
        '[ -f "$0" ] || exit 3; tail -c "+$(( $1 + 1 ))" "$0" | head -c "$2"',
        file,
        String(offset),
        String(MAX_LOG_CHUNK_BYTES),
      ],
      { env: BASE_ENV },
    );
    const output = await proc.output();
    return {
      bytes: output.stdout,
      nextOffset: offset + output.stdout.byteLength,
      found: output.exitCode !== 3,
    };
  }
  async stopJob(jobId) {
    const status = await this.jobStatus(jobId);
    if (status.state === "running" && status.pid) await this.#run(["kill", "-TERM", `-${status.pid}`], {});
    return this.jobStatus(jobId);
  }
  /** Short buffered command, for small reads such as `git diff` or `cat`. */
  async exec(argv, options) {
    return this.#run(argv, {
      cwd: options.cwd,
      env: options.env,
      timeoutSec: Math.min(options.timeoutSec ?? 60, MAX_EXEC_SECONDS),
    });
  }
  async readFile(path) {
    const response = await this.#files.readFile(path);
    return response.arrayBuffer();
  }
  async writeFile(path, content) {
    await this.#files.writeFile(path, content);
    return { path, bytes: content.byteLength };
  }
  async snapshot(name) {
    const started = Date.now();
    const snap = await this.#container.snapshotContainer({ name });
    return { ...snap, ms: Date.now() - started };
  }
  async saveCache(name, dir) {
    const started = Date.now();
    const record2 = await this.#backups.backup({ dir, name });
    return { record: record2, ms: Date.now() - started };
  }
  async restoreCache(record2, dir) {
    const started = Date.now();
    await this.#backups.restore(record2, dir ? { dir } : void 0);
    return { ms: Date.now() - started };
  }
  async recordEgress(event) {
    this.ctx.storage.sql.exec(
      "INSERT INTO egress (at, phase, method, host, path) VALUES (?, ?, ?, ?, ?)",
      event.at,
      event.phase,
      event.method,
      event.host,
      event.path,
    );
  }
  async egress() {
    return this.ctx.storage.sql
      .exec("SELECT at, phase, method, host, path FROM egress ORDER BY at")
      .toArray();
  }
  async destroy() {
    if (this.#container.running) await this.#container.destroy();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return { destroyed: true };
  }
  /** Keeps the instance alive while jobs run, and forgets jobs that ended. */
  async alarm() {
    if (!this.#container.running) return;
    const jobs = await this.ctx.storage.list({ prefix: "job:" });
    let active = false;
    for (const key of jobs.keys()) {
      const status = await this.jobStatus(key.slice(4));
      if (status.state === "running" || status.state === "starting") active = true;
      else await this.ctx.storage.delete(key);
    }
    if (active) await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
  }
  async #ensureAlarm() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
  }
  async #sid() {
    const sid = await this.ctx.storage.get("sid");
    if (!sid) throw new Error("conflict: sandbox not started");
    return sid;
  }
  async #routeEgress(sid, phase, tarball) {
    const egress = this.ctx.exports.Egress({ props: { sid, phase, tarball } });
    await this.#container.interceptOutboundHttps("*", egress);
    await this.#container.interceptAllOutboundHttp(egress);
  }
  /** The CA file appears after start; add it to the system store so curl, git and npm trust it. */
  #trustInterceptCa() {
    return this.#run(
      [
        "bash",
        "-c",
        'for i in $(seq 1 100); do [ -s "$0" ] && break; sleep 0.1; done; cp "$0" /usr/local/share/ca-certificates/cloudflare-containers.crt && update-ca-certificates >/dev/null',
        INTERCEPT_CA,
      ],
      { timeoutSec: 30 },
    );
  }
  async #run(argv, options) {
    const started = Date.now();
    const limit = String(MAX_EXEC_OUTPUT_BYTES);
    const proc = await this.#container.exec(
      [
        "bash",
        "-c",
        // Cap each stream so a chatty command can't exhaust the Durable Object's memory.
        'limit="$0"; t="$1"; shift 1; timeout --kill-after=5 "$t" "$@" > >(head -c "$limit") 2> >(head -c "$limit" >&2)',
        limit,
        String(options.timeoutSec ?? 60),
        ...argv,
      ],
      { cwd: options.cwd, env: { ...BASE_ENV, ...options.env } },
    );
    const output = await proc.output();
    return {
      exitCode: output.exitCode,
      stdout: decoder2.decode(output.stdout),
      stderr: decoder2.decode(output.stderr),
      ms: Date.now() - started,
    };
  }
};
function sandboxStub(env, sid) {
  return env.SANDBOX.getByName(sid);
}
__name(sandboxStub, "sandboxStub");
var encoder2 = new TextEncoder();
function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
__name(base64url, "base64url");
async function authorized(request, env, sid) {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer (\d+)\.([A-Za-z0-9_-]+)$/.exec(header);
  if (!match || !env.TEIRE_SANDBOX_KEY) return false;
  const expiry = Number(match[1]);
  const now = Math.floor(Date.now() / 1e3);
  if (expiry < now || expiry > now + MAX_TOKEN_TTL_SECONDS) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder2.encode(env.TEIRE_SANDBOX_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = encoder2.encode(
    base64url(await crypto.subtle.sign("HMAC", key, encoder2.encode(`${sid}.${expiry}`))),
  );
  const given = encoder2.encode(match[2] ?? "");
  return given.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(given, expected);
}
__name(authorized, "authorized");
function json2(body, status = 200) {
  return Response.json(body, { status });
}
__name(json2, "json");
function errorResponse(error) {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.startsWith("bad request") ? 400 : message.startsWith("conflict") ? 409 : 500;
  return json2({ error: message }, status);
}
__name(errorResponse, "errorResponse");
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "v1" || parts[1] !== "sandboxes" || !parts[2]) return json2({ error: "not found" }, 404);
    const sid = parts[2];
    if (!SANDBOX_ID.test(sid)) return json2({ error: "bad request: invalid sandbox id" }, 400);
    if (!(await authorized(request, env, sid))) return json2({ error: "unauthorized" }, 401);
    const sandbox = sandboxStub(env, sid);
    const route = `${request.method} ${parts.slice(3).join("/")}`;
    try {
      if (route === "POST ") return json2(await sandbox.start(sid, await request.json()), 201);
      if (route === "DELETE ") return json2(await sandbox.destroy());
      if (route === "PUT phase") return json2(await sandbox.setPhase((await request.json()).phase));
      if (route === "POST exec") {
        const body = await request.json();
        return json2(await sandbox.exec(body.argv, body));
      }
      if (route === "POST jobs") {
        const body = await request.json();
        return json2(await sandbox.startJob(body.jobId, body.argv, body), 201);
      }
      if (parts[3] === "jobs" && parts[4]) {
        const jobId = parts[4];
        if (request.method === "GET" && parts.length === 5) return json2(await sandbox.jobStatus(jobId));
        if (request.method === "DELETE" && parts.length === 5) return json2(await sandbox.stopJob(jobId));
        if (request.method === "GET" && parts[5] === "log") {
          const stream = url.searchParams.get("stream") === "stderr" ? "stderr" : "stdout";
          const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
          const log = await sandbox.jobLog(jobId, stream, offset);
          if (!log.found) return json2({ error: "log not found" }, 404);
          return new Response(log.bytes, {
            headers: { "x-next-offset": String(log.nextOffset), "content-type": "application/octet-stream" },
          });
        }
      }
      if (parts[3] === "files") {
        const path = url.searchParams.get("path") ?? "";
        if (!path.startsWith("/")) return json2({ error: "bad request: absolute path required" }, 400);
        if (request.method === "GET") return new Response(await sandbox.readFile(path));
        if (request.method === "PUT")
          return json2(await sandbox.writeFile(path, await request.arrayBuffer()));
      }
      if (route === "POST snapshot") return json2(await sandbox.snapshot((await request.json()).name));
      if (route === "POST cache/save") {
        const body = await request.json();
        return json2(await sandbox.saveCache(body.name, body.dir));
      }
      if (route === "POST cache/restore") {
        const body = await request.json();
        return json2(await sandbox.restoreCache(body.record, body.dir));
      }
      if (route === "GET egress") return json2(await sandbox.egress());
      return json2({ error: "not found" }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  },
};

export { DirectoryBackupGateway, Egress, index_default as default, VerifySandbox };
/*! Bundled license information:

aws4fetch/dist/aws4fetch.esm.mjs:
  (**
   * @license MIT <https://opensource.org/licenses/MIT>
   * @copyright Michael Hart 2024
   *)
*/
//# sourceMappingURL=index.js.map
