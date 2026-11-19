"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { pathToFileURL } = require("node:url");
const { recall_catalog, timestamp } = require("../anti-recall-repair/viewer/recall_catalog");
const { recall_media } = require("../anti-recall-repair/viewer/recall_media");
const { jump_script, jump_message } = require("../anti-recall-repair/viewer/recall_jump");
const { recall_viewer } = require("../anti-recall-repair/viewer/recall_viewer");

function saved(index = 1, changes = {}) {
    return { id: String(index), sender: "123456789", msg: {
        msgId: String(90071992547409930n + BigInt(index)), msgTime: String(1700000000 + index),
        chatType: 2, peerUid: "123456789", peerName: "项目讨论群", peerUin: "123456789",
        senderUid: "u_sender", senderUin: "10001", sendMemberName: "小林",
        elements: [{ textElement: { content: "关键记录 " + index } }], ...changes
    } };
}

test("旧数据库结构按会话分组、搜索发送者或正文，消息 ID 保持字符串精度", () => {
    const catalog = new recall_catalog();
    for (let index = 1; index <= 73; index++) catalog.remember(saved(index));
    catalog.remember(saved(90, { peerUid: "u_friend", peerName: "朋友", chatType: 1 }));
    const result = catalog.list();
    assert.equal(result.total, 74); assert.equal(result.conversations.length, 2);
    assert.equal(catalog.list("小林").matched, 74);
    assert.equal(catalog.list("关键记录 73").matched, 1);
    const group = result.conversations.find(item => item.chat_type === 2);
    const latest = catalog.messages({ conversation_id: group.id, limit: 50 });
    assert.equal(latest.records.length, 50); assert.equal(latest.next_offset, 50);
    assert.equal(latest.records.at(-1).msg_id, "90071992547410003");
    const older = catalog.messages({ conversation_id: group.id, offset: 50, limit: 50 });
    assert.equal(older.records.length, 23); assert.equal(older.next_offset, null);
    assert.equal(new Set([...older.records, ...latest.records].map(item => item.id)).size, 73);
});

test("新旧记录去重并保留账号定位信息，同会话的新旧消息集中显示", () => {
    const catalog = new recall_catalog();
    const old = saved(); catalog.remember(old);
    const newer = { ...old, account_uid: "u_owner" }; catalog.remember(newer); catalog.remember(old);
    catalog.remember(saved(2));
    assert.equal(catalog.list().total, 2); assert.equal(catalog.list().conversations.length, 1);
    assert.equal(catalog.target(catalog.messages({ conversation_id: catalog.list().conversations[0].id }).records[0].id).account_uid, "u_owner");
    catalog.clear(); assert.equal(catalog.list().total, 0);
    assert.throws(() => catalog.target("missing"), /不存在/);
});

test("文字、图片和附件转换为纯数据，错误记录被忽略", () => {
    const catalog = new recall_catalog({ register_asset: () => "asset-token" });
    catalog.remember(saved(1, { elements: [
        { textElement: { content: '<img src=x onerror="evil()">' } },
        { picElement: { sourcePath: "C:/private/image.png" } },
        { fileElement: { fileName: "附件.txt" } }, { pttElement: { duration: 3 } },
        { arkElement: { bytesData: '<script>evil()</script>' } }
    ] }));
    assert.equal(catalog.remember({ invalid: true }), null);
    const record = catalog.messages({ conversation_id: catalog.list().conversations[0].id }).records[0];
    assert.equal(record.parts[0].text, '<img src=x onerror="evil()">');
    assert.equal(record.parts[1].asset_id, "asset-token");
    assert.equal(JSON.stringify(record).includes("C:/private"), false);
    assert.equal(JSON.stringify(record).includes("<script>"), false);
    assert.equal(timestamp("1700000000"), 1700000000000);
    assert.equal(timestamp(1700000000000), 1700000000000);
    assert.equal(timestamp("bad"), 0);
});

test("图片仅能通过登记令牌读取，错误文件不能作为图片发送", async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "recall-viewer-media-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9sAAAAASUVORK5CYII=", "base64");
    const file = path.join(root, "image.png"); await fs.writeFile(file, png);
    const media = new recall_media({ candidates: () => [{ path: file }] });
    const token = media.register("record", 0, {}, {});
    assert.match((await media.read(token)).url, /^data:image\/png;base64,/);
    await assert.rejects(media.read(file), /不存在/);
    await fs.writeFile(file, "server error, no image");
    await assert.rejects(media.read(token), /未保存/);
    media.clear(); await assert.rejects(media.read(token), /不存在/);
});

test("双击定位传入会话和精确消息 ID，消息身份经过 JSON 转义", async () => {
    let posted;
    const target = { peer_uid: "group';globalThis.executed=true;//", msg_id: "90071992547410003", chat_type: 2 };
    const context = { crypto: { randomUUID: () => "request-id" }, BroadcastChannel: class {
        constructor(name) { assert.equal(name, "MainWindow"); }
        postMessage(value) { posted = value; } close() {}
    } };
    vm.runInNewContext(jump_script(target), context);
    assert.equal(context.executed, undefined);
    assert.equal(posted.params.cmdName, "jumpNewAio");
    assert.equal(posted.params.args[0].params.msgId, target.msg_id);
    assert.equal(posted.params.args[0].peerUid, target.peer_uid);
    const events = [];
    const window = { isDestroyed: () => false, isMinimized: () => true,
        restore: () => events.push("restore"), show: () => events.push("show"), focus: () => events.push("focus"),
        webContents: { isDestroyed: () => false, getURL: () => "app://qq/#/main/message",
            executeJavaScript: async source => events.push(source.includes('params:') ? "dispatch" : "bad"), focus: () => events.push("web-focus") } };
    assert.equal((await jump_message(target, { windows: [window] })).dispatched, true);
    assert.deepEqual(events, ["dispatch", "restore", "show", "focus", "web-focus"]);
    await assert.rejects(jump_message({ ...target, account_uid: "other" }, { windows: [window], account_uid: "current" }), /其它 QQ 账号/);
    await assert.rejects(jump_message(target, { windows: [] }), /主窗口/);
});

test("查看窗口单例、历史加载错误明确显示、IPC 拒绝其它页面", async () => {
    const handlers = new Map();
    const windows = [];
    class fake_window extends EventEmitter {
        constructor(options) {
            super(); this.options = options; this.url = "";
            this.webContents = new EventEmitter();
            this.webContents.getURL = () => this.url;
            this.webContents.setWindowOpenHandler = () => {};
            this.webContents.send = () => {};
            windows.push(this);
        }
        isDestroyed() { return false; } isMinimized() { return false; }
        setMenu() {} show() {} focus() {}
        async loadFile(file) { this.url = pathToFileURL(file).href; this.emit("ready-to-show"); }
        static getAllWindows() { return windows; }
    }
    let failing = false;
    const viewer = new recall_viewer({ electron: { BrowserWindow: fake_window, ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, dialog: {} },
        candidates: () => [], saved: () => true, read_records: async () => { if (failing) throw new Error("模拟数据库错误"); return [saved()]; } });
    viewer.open(); viewer.open(); assert.equal(windows.length, 1);
    assert.equal(windows[0].options.webPreferences.nodeIntegration, false);
    const good = { sender: windows[0].webContents };
    const list = handlers.get("LiteLoader.anti_recall.viewer.list");
    assert.equal((await list(good, {})).data.total, 1);
    const denied = await list({ sender: { getURL: () => "https://example.org/" } }, {});
    assert.equal(denied.ok, false);
    failing = true;
    const failed = await list(good, { refresh: true });
    assert.match(failed.data.warning, /模拟数据库错误/); assert.equal(failed.data.total, 1);
    viewer.clear(); failing = false; viewer.remember(saved(2));
    assert.equal(viewer.catalog.list().total, 1);
});
