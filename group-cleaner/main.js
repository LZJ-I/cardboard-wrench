"use strict";

const path = require("node:path");
const { ipcMain, webContents, BrowserWindow, dialog } = require("electron");
const { NativeTransport } = require("./lib/native_transport.js");
const { GroupClient } = require("./lib/group_client.js");
const { Preferences } = require("./lib/preferences.js");
const { BatchManager } = require("./lib/batch_manager.js");
const { valid_group_id } = require("./lib/group_model.js");
const { open_group } = require("./lib/group_actions.js");
const { NativeCalibration } = require("./lib/native_calibration.js");

// 此入口拥有 Electron IPC 绑定，具体状态分别由 client、preferences、manager 管理。
const prefix = "LiteLoader.group_cleaner.";
let startup_error = "";
let client;
let manager;
let transport;
let calibration;
const preferences = new Preferences(path.join(LiteLoader.path.data, "group_cleaner"));

function requester_alive(id) {
    const contents = webContents.fromId(id);
    return Boolean(contents && !contents.isDestroyed());
}

function publish(job) {
    for (const contents of webContents.getAllWebContents()) {
        if (!contents.isDestroyed() && contents.getURL().startsWith("app://")) {
            try { contents.send(prefix + "progress", job); }
            catch { /* 窗口退出时，剩余面板仍可读取执行状态。 */ }
        }
    }
}

function publish_calibration(state) {
    for (const contents of webContents.getAllWebContents()) {
        if (!contents.isDestroyed() && contents.getURL().startsWith("app://")) {
            try { contents.send(prefix + "calibration", state); } catch { }
        }
    }
}

function publish_account_change() {
    for (const contents of webContents.getAllWebContents()) {
        if (!contents.isDestroyed() && contents.getURL().startsWith("app://")) {
            try { contents.send(prefix + "account_changed"); } catch { }
        }
    }
}

function assert_sender(event) {
    const url = event.sender.getURL();
    if (!url.startsWith("app://") || !/#\/(setting|main)(?:\/|$)/.test(url) ||
        (event.senderFrame && event.sender.mainFrame && event.senderFrame !== event.sender.mainFrame)) {
        throw new Error("此操作仅支持 QQ 主窗口或设置面板");
    }
    if (startup_error) throw new Error(startup_error);
}

function bind(name, handler) {
    ipcMain.handle(prefix + name, async (event, ...args) => {
        try {
            assert_sender(event);
            return { ok: true, data: await handler(event, ...args) };
        } catch (error) {
            return { ok: false, error: error.message || String(error) };
        }
    });
}

try {
    if (!globalThis.IpcInterceptor?.onIpcSend) throw new Error("IPC 前置插件未启用，请在 LiteLoader 中启用 ipc_interceptor 后重启");
    transport = new NativeTransport({
        ipc_main: ipcMain, web_contents: webContents, interceptor: globalThis.IpcInterceptor,
        dispatch: (peer, header, command) => peer.send(prefix + "native_request", header, command)
    });
    client = new GroupClient(transport, preferences, () => {
        manager?.stop();
        if (calibration?.active) calibration.finish("账号已变化，校准已停止。");
        publish_account_change();
    });
    calibration = new NativeCalibration({
        interceptor: globalThis.IpcInterceptor, transport,
        account: () => client.account_uid, groups: () => client.groups,
        data_path: path.join(LiteLoader.path.data, "group_cleaner"),
        qq_version: LiteLoader.versions.qqnt, publish: publish_calibration
    });
    manager = new BatchManager({
        account: () => client.account_uid,
        read_groups: () => client.refresh(),
        quit_group: id => calibration.request_quit(id),
        requester_alive,
        delay: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
        publish,
        confirm: async plan => {
            const requester = webContents.fromId(plan.requester_id);
            if (!requester || requester.isDestroyed()) return false;
            const parent = BrowserWindow.fromWebContents(requester);
            const options = {
                type: "warning",
                title: "确认退出群聊",
                message: `退出所选的 ${plan.groups.length} 个群？`,
                detail: plan.groups.map((group, index) => `${index + 1}. ${group.name}（${group.id}）`).join("\n") +
                    "\n\n退出后需重新申请才能加入。" + (calibration.snapshot().clears_records ?
                        "\nQQ 原生调用含有清理本地记录的设置；本次将沿用该设置，请先保存需要的记录。" : ""),
                buttons: ["取消", `退出 ${plan.groups.length} 个群`],
                defaultId: 0, cancelId: 0, noLink: true
            };
            const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
            return result.response === 1;
        }
    });
} catch (error) {
    startup_error = error.message;
    console.warn("[群清理助手]", startup_error);
}

bind("state", async () => ({
    ...(client?.snapshot() ?? { groups: [], updated_at: 0 }),
    account: client?.account_uid ?? "", job: manager?.snapshot() ?? null,
    version: "0.1.4", qq_version: LiteLoader.versions.qqnt,
    calibration: calibration?.snapshot()
}));
bind("refresh", async () => {
    if (manager.busy) throw new Error("任务执行中，请等待或先停止任务");
    await client.refresh();
    return { ...client.snapshot(), account: client.account_uid, job: manager.snapshot(), calibration: calibration.snapshot() };
});
bind("retain", async (_event, id, retained) => {
    if (manager.busy) throw new Error("任务执行中不能修改保留名单");
    if (!valid_group_id(id) || typeof retained !== "boolean" || !client.groups.some(group => group.id === id)) {
        throw new Error("无效的群聊或保留标记");
    }
    preferences.set_retained(client.account_uid, id, retained);
    return client.snapshot();
});
bind("open_group", async (_event, id) => {
    if (manager.busy) throw new Error("退群任务执行中，请等待或先停止任务");
    if (!client.account_uid || !valid_group_id(id) || !client.groups.some(group => group.id === id)) {
        throw new Error("该群不在当前列表中，请刷新后重试");
    }
    return open_group(transport, BrowserWindow, id);
});
bind("calibrate", async () => {
    if (manager.busy) throw new Error("请先停止退群任务，再开始校准");
    await client.refresh();
    if (manager.busy) throw new Error("已有退群任务开始，请等待或先停止");
    manager.stop();
    const state = calibration.begin();
    return { ...client.snapshot(), account: client.account_uid, job: manager.snapshot(), calibration: state };
});
bind("cancel_calibration", () => {
    calibration.finish();
    return calibration.snapshot();
});
bind("prepare", (event, ids) => {
    if (!calibration.template || calibration.active) throw new Error("请先完成一次成功的 QQ 原生退群校准");
    return manager.prepare(ids, event.sender.id);
});
bind("start", (event, token) => {
    if (!calibration.template || calibration.active) throw new Error("请先完成原生退群校准");
    return manager.start(token, event.sender.id);
});
bind("stop", () => manager.stop());

module.exports.onLogin = uid => client?.set_account(uid);
