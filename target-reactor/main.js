"use strict";

const path = require("node:path");
const { app, ipcMain, webContents } = require("electron");
const { native_transport } = require("./lib/native_transport");
const { preferences } = require("./lib/preferences");
const { load_catalog } = require("./lib/emoji_catalog");
const { reaction_engine } = require("./lib/reaction_engine");

// 此入口拥有 QQ 通知订阅及面板 IPC；规则执行状态由 reaction_engine 管理。
const prefix = "LiteLoader.target_reactor.";
let startup_error = "";
let engine;
let transport;
let publish_timer;
let catalog = [];

function publish() {
    if (publish_timer) return;
    publish_timer = setTimeout(() => {
        publish_timer = null;
        for (const contents of webContents.getAllWebContents()) {
            if (!contents.isDestroyed() && contents.getURL().startsWith("app://") && /#\/setting(?:\/|$)/.test(contents.getURL())) {
                contents.send(prefix + "changed");
            }
        }
    }, 200);
    publish_timer.unref?.();
}

try {
    if (!globalThis.IpcInterceptor?.onIpcSend) throw new Error("请启用 IPC 事件拦截器后重新启动 QQ");
    catalog = load_catalog({ resources: [process.resourcesPath,
        path.join(path.dirname(process.execPath), "versions", String(LiteLoader.versions.qqnt), "resources")], documents: app.getPath("documents") });
    transport = new native_transport({ ipc_main: ipcMain, web_contents: webContents, interceptor: globalThis.IpcInterceptor });
    engine = new reaction_engine({ preferences: new preferences(path.join(LiteLoader.path.data, "target_reactor")),
        catalog, send: payload => transport.request(payload), publish });
    transport.observe((channel, _header, body) => {
        if (!/^RM_IPCFROM_MAIN\d+$/.test(channel)) return;
        const contents = webContents.fromId(Number(channel.slice("RM_IPCFROM_MAIN".length)));
        if (!contents || contents.isDestroyed() || !contents.getURL().startsWith("app://") || !/#\/(?:main|chat)(?:\/|$)/.test(contents.getURL())) return;
        const commands = Array.isArray(body) ? body : [body];
        for (const command of commands) {
            if (!command?.cmdName || !command.payload) continue;
            engine.receive(command.cmdName, command.payload.msgList);
        }
    });
} catch (error) { startup_error = error.message; console.warn("[定点表情回应]", error); }

function bind(name, callback) {
    ipcMain.handle(prefix + name, async (event, ...args) => {
        try {
            const url = event.sender.getURL();
            if (!url.startsWith("app://") || !/#\/setting(?:\/|$)/.test(url) ||
                (event.senderFrame && event.sender.mainFrame && event.senderFrame !== event.sender.mainFrame)) throw new Error("请从定点表情回应设置页操作");
            if (startup_error) throw new Error(startup_error);
            return { ok: true, data: await callback(...args) };
        } catch (error) { return { ok: false, error: error.message || String(error) }; }
    });
}
bind("state", include_catalog => ({ ...engine.snapshot(), ...(include_catalog === true ? { catalog } : {}), version: "0.1.0" }));
bind("save", value => engine.configure(value));

module.exports.onLogin = uid => {
    if (!engine) return;
    try { engine.set_account(uid); startup_error = ""; }
    catch (error) { startup_error = error.message; console.warn("[定点表情回应]", error.message); }
    publish();
};
app.on("before-quit", () => { clearTimeout(publish_timer); engine?.dispose(); transport?.dispose(); });
