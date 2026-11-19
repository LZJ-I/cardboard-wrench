"use strict";

// src/main/modules/proxyIpcMessage.ts
var import_electron = require("electron");

// src/main/modules/createLogger.ts
var LocalLogger = class {
  constructor(moduleName) {
    this.moduleName = moduleName;
  }
  log = (...args) => {
    console.log(`[${this.moduleName}]`, ...args);
  };
};
function createLogger(moduleName) {
  const logsInstance = "Logs" in globalThis ? new Logs(moduleName) : new LocalLogger(moduleName).log;
  return (...args) => {
    logsInstance(...args);
  };
}

// src/main/modules/proxyIpcMessage.ts
var log = createLogger("IPC Proxy");
setTimeout(() => {
  log = createLogger("IPC Proxy");
  log("loaded");
}, 100);
var ipcReceiveHandlers = /* @__PURE__ */ new Set();
var ipcSendHandlers = /* @__PURE__ */ new Set();
var interceptIpcReceiveHandlers = /* @__PURE__ */ new Set();
var interceptIpcSendHandlers = /* @__PURE__ */ new Set();
var ipcReceiveEventHandlers = /* @__PURE__ */ new Map();
var ipcSendEventHandlers = /* @__PURE__ */ new Map();
var interceptIpcReceiveEventHandlers = /* @__PURE__ */ new Map();
var interceptIpcSendEventHandlers = /* @__PURE__ */ new Map();
var proxyFlag = Symbol("isProxyed");
var isProxySession = false;
function normalizeEventNames(eventName) {
  return Array.isArray(eventName) ? eventName : [eventName];
}
function normalizeEvents(args, direction) {
  const len = args.length;
  if (direction === "out") {
    if (isProxySession) {
      return len === 4 ? [args[0], args[2], args[3]] : args.slice(0, 3);
    } else {
      return len === 3 ? [args[0], false, args[1], args[2]] : args.slice(0, 4);
    }
  }
  return len === 3 ? [args[0], false, args[1], args[2]] : args.slice(0, 4);
}
function onIpcReceive(callback) {
  if (typeof callback === "function") {
    ipcReceiveHandlers.add(callback);
    return () => offIpcReceive(callback);
  }
  return () => {
  };
}
function onIpcSend(callback) {
  if (typeof callback === "function") {
    ipcSendHandlers.add(callback);
    return () => offIpcSend(callback);
  }
  return () => {
  };
}
function onIpcReceiveEvents(eventName, callback) {
  if (typeof callback !== "function") return () => {
  };
  const names = normalizeEventNames(eventName);
  names.forEach((name) => {
    if (!ipcReceiveEventHandlers.has(name)) {
      ipcReceiveEventHandlers.set(name, /* @__PURE__ */ new Set());
    }
    ipcReceiveEventHandlers.get(name).add(callback);
  });
  return () => offIpcReceiveEvents(eventName, callback);
}
function onIpcSendEvents(eventName, callback) {
  if (typeof callback !== "function") return () => {
  };
  const names = normalizeEventNames(eventName);
  names.forEach((name) => {
    if (!ipcSendEventHandlers.has(name)) {
      ipcSendEventHandlers.set(name, /* @__PURE__ */ new Set());
    }
    ipcSendEventHandlers.get(name).add(callback);
  });
  return () => offIpcSendEvents(eventName, callback);
}
function interceptIpcReceive(callback) {
  if (typeof callback === "function") {
    interceptIpcReceiveHandlers.add(callback);
    return () => offInterceptIpcReceive(callback);
  }
  return () => {
  };
}
function interceptIpcSend(callback) {
  if (typeof callback === "function") {
    interceptIpcSendHandlers.add(callback);
    return () => offInterceptIpcSend(callback);
  }
  return () => {
  };
}
function interceptIpcReceiveEvents(eventName, callback) {
  if (typeof callback !== "function") return () => {
  };
  const names = normalizeEventNames(eventName);
  names.forEach((name) => {
    if (!interceptIpcReceiveEventHandlers.has(name)) {
      interceptIpcReceiveEventHandlers.set(name, /* @__PURE__ */ new Set());
    }
    interceptIpcReceiveEventHandlers.get(name).add(callback);
  });
  return () => offInterceptIpcReceiveEvents(eventName, callback);
}
function interceptIpcSendEvents(eventName, callback) {
  if (typeof callback !== "function") return () => {
  };
  const names = normalizeEventNames(eventName);
  names.forEach((name) => {
    if (!interceptIpcSendEventHandlers.has(name)) {
      interceptIpcSendEventHandlers.set(name, /* @__PURE__ */ new Set());
    }
    interceptIpcSendEventHandlers.get(name).add(callback);
  });
  return () => offInterceptIpcSendEvents(eventName, callback);
}
function offIpcReceive(callback) {
  ipcReceiveHandlers.delete(callback);
}
function offIpcSend(callback) {
  ipcSendHandlers.delete(callback);
}
function offIpcReceiveEvents(eventName, callback) {
  const names = normalizeEventNames(eventName);
  names.forEach((name) => {
    const set = ipcReceiveEventHandlers.get(name);
    if (set) {
      set.delete(callback);
      if (set.size === 0) {
        ipcReceiveEventHandlers.delete(name);
      }
    }
  });
}
function offIpcSendEvents(eventName, callback) {
  const names = normalizeEventNames(eventName);
  names.forEach((name) => {
    const set = ipcSendEventHandlers.get(name);
    if (set) {
      set.delete(callback);
      if (set.size === 0) {
        ipcSendEventHandlers.delete(name);
      }
    }
  });
}
function offInterceptIpcReceive(callback) {
  interceptIpcReceiveHandlers.delete(callback);
}
function offInterceptIpcSend(callback) {
  interceptIpcSendHandlers.delete(callback);
}
function offInterceptIpcReceiveEvents(eventName, callback) {
  const names = normalizeEventNames(eventName);
  names.forEach((name) => {
    const set = interceptIpcReceiveEventHandlers.get(name);
    if (set) {
      set.delete(callback);
      if (set.size === 0) {
        interceptIpcReceiveEventHandlers.delete(name);
      }
    }
  });
}
function offInterceptIpcSendEvents(eventName, callback) {
  const names = normalizeEventNames(eventName);
  names.forEach((name) => {
    const set = interceptIpcSendEventHandlers.get(name);
    if (set) {
      set.delete(callback);
      if (set.size === 0) {
        interceptIpcSendEventHandlers.delete(name);
      }
    }
  });
}
function proxyIpcMessages(window) {
  if (!(window instanceof import_electron.BrowserWindow)) {
    throw new TypeError("Expected a BrowserWindow instance");
  }
  if (window[proxyFlag]) return;
  window[proxyFlag] = true;
  const webContents = window.webContents;
  let events = webContents._events;
  log(`Proxying IPC for window: ${window.id}`);
  if (!events["-ipc-message"]) {
    isProxySession = true;
    events = webContents.session._events;
    log(`Proxying IPC receive for session`);
  } else {
    log(`Proxying IPC receive for webContents`);
  }
  if (!events) {
    log("No events found on webContents or session.");
    return;
  }
  if (events["-ipc-message"] && !events[proxyFlag]) {
    events[proxyFlag] = true;
    const originalReceive = events["-ipc-message"];
    events["-ipc-message"] = new Proxy(originalReceive, {
      apply(target, thisArg, args) {
        const legacyArgs = normalizeEvents(args, "in");
        for (const handler of interceptIpcReceiveHandlers) {
          try {
            const result = handler(...legacyArgs);
            if (result) {
              if (Array.isArray(result)) {
                args = normalizeEvents(result, "out");
              } else {
                if (result.action === "replace" && result.args) {
                  args = normalizeEvents(result.args, "out");
                } else if (result.action === "block") {
                  return;
                }
              }
            }
          } catch (err) {
            log("Intercept receive handler error:", err, err?.stack);
          }
        }
        const ipcRecvInterceptorsSet = interceptIpcReceiveEventHandlers.get(legacyArgs?.[3]?.[1]?.cmdName);
        if (ipcRecvInterceptorsSet) {
          for (const handler of ipcRecvInterceptorsSet) {
            try {
              const result = handler(...legacyArgs);
              if (result) {
                if (Array.isArray(result)) {
                  args = normalizeEvents(result, "out");
                } else {
                  if (result.action === "replace" && result.args) {
                    args = normalizeEvents(result.args, "out");
                  } else if (result.action === "block") {
                    return;
                  }
                }
              }
            } catch (err) {
              log("Intercept receive event handler error:", err, err?.stack);
            }
          }
        }
        for (const handler of ipcReceiveHandlers) {
          try {
            handler(...legacyArgs);
          } catch (err) {
            log("Receive handler error:", err, err?.stack);
          }
        }
        const ipcReceiveHandlersSet = ipcReceiveEventHandlers.get(legacyArgs?.[3]?.[1]?.cmdName);
        if (ipcReceiveHandlersSet) {
          for (const handler of ipcReceiveHandlersSet) {
            try {
              handler(...legacyArgs);
            } catch (err) {
              log("Receive event handler error:", err, err?.stack);
            }
          }
        }
        return target.apply(thisArg, args);
      }
    });
  } else if (events[proxyFlag]) {
    log("'-ipc-message' already proxied.");
  } else {
    log("No '-ipc-message' listener found.");
  }
  const originalSend = window.webContents.send;
  window.webContents.send = new Proxy(originalSend, {
    apply(target, thisArg, args) {
      for (const handler of interceptIpcSendHandlers) {
        try {
          const result = handler(...args);
          if (result) {
            if (Array.isArray(result)) {
              args = result;
            } else {
              if (result.action === "replace" && result.args) {
                args = result.args;
              } else if (result.action === "block") {
                return;
              }
            }
          }
        } catch (err) {
          log("Intercept send handler error:", err, err?.stack);
        }
      }
      const ipcSendInterceptorsSet = interceptIpcSendEventHandlers.get(args?.[2]?.cmdName);
      if (ipcSendInterceptorsSet) {
        for (const handler of ipcSendInterceptorsSet) {
          try {
            const result = handler(...args);
            if (result) {
              if (Array.isArray(result)) {
                args = result;
              } else {
                if (result.action === "replace" && result.args) {
                  args = result.args;
                } else if (result.action === "block") {
                  return;
                }
              }
            }
          } catch (err) {
            log("Intercept send event handler error:", err, err?.stack);
          }
        }
      }
      for (const handler of ipcSendHandlers) {
        try {
          handler(...args);
        } catch (err) {
          log("Send handler error:", err, err?.stack);
        }
      }
      const ipcSendHandlersSet = ipcSendEventHandlers.get(args?.[2]?.cmdName);
      if (ipcSendHandlersSet) {
        for (const handler of ipcSendHandlersSet) {
          try {
            handler(...args);
          } catch (err) {
            log("Send event handler error:", err, err?.stack);
          }
        }
      }
      return target.apply(thisArg, args);
    }
  });
}
var IpcInterceptor = {
  onIpcReceive,
  onIpcSend,
  onIpcReceiveEvents,
  onIpcSendEvents,
  offIpcReceive,
  offIpcSend,
  offIpcReceiveEvents,
  offIpcSendEvents,
  interceptIpcReceive,
  interceptIpcSend,
  interceptIpcReceiveEvents,
  interceptIpcSendEvents,
  offInterceptIpcReceive,
  offInterceptIpcSend,
  offInterceptIpcReceiveEvents,
  offInterceptIpcSendEvents
};

// src/main/index.ts
function onBrowserWindowCreated(window) {
  proxyIpcMessages(window);
}
globalThis.IpcInterceptor = IpcInterceptor;
if ("qwqnt" in globalThis) {
  qwqnt.main.hooks.whenBrowserWindowCreated.peek(onBrowserWindowCreated);
}
module.exports = { onBrowserWindowCreated };
