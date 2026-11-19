"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const fs_sync = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { reaction_engine } = require("../target-reactor/lib/reaction_engine");
const { native_transport } = require("../target-reactor/lib/native_transport");
const { preferences } = require("../target-reactor/lib/preferences");
const { validate_config, check_result } = require("../target-reactor/lib/rules");
const { load_catalog } = require("../target-reactor/lib/emoji_catalog");

const catalog = [{ id: "128541", type: "2", label: "吐舌", src: "data:image/png;base64,test" }];
const config = () => ({ enabled: true, rules: [{ id: "rule1", group_id: "12345678", member_id: "10001", emoji_id: "128541", label: "目标成员", enabled: true }] });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { const deadline = Date.now() + 2000; while (!await predicate()) { if (Date.now() > deadline) throw new Error("等待测试状态超时"); await delay(2); } }
class memory_preferences {
    constructor() { this.values = new Map(); }
    config(account) { return structuredClone(this.values.get(account + ":rules") || { enabled: false, rules: [] }); }
    processed(account) { return this.values.get(account + ":processed") || []; }
    write(account, name, value) { this.values.set(account + ":" + name, structuredClone(value)); }
}
function msg(index = 1, fields = {}) {
    return { msgId: String(90071992547409930n + BigInt(index)), msgSeq: String(1000 + index), msgType: 2, chatType: 2,
        peerUid: "12345678", peerUin: "12345678", peerName: "测试群", senderUid: "u_member", senderUin: "10001",
        msgTime: String(Math.floor(Date.now() / 1000)), isOnlineMsg: true, sendType: 0, ...fields };
}
function setup(t, options = {}) {
    const sent = [];
    const engine = new reaction_engine({ preferences: new memory_preferences(), catalog, interval_ms: 2,
        send: async payload => { sent.push(payload); return { result: 0 }; }, ...options });
    engine.set_account("u_self"); engine.configure(config());
    t.after(() => engine.dispose());
    return { engine, sent };
}

test("严格按群与成员匹配，只发一个正确的原生表情回应请求", async t => {
    const { engine, sent } = setup(t);
    engine.receive("nodeIKernelMsgListener/onRecvMsg", [msg(1, { peerUid: "99999999", peerUin: "99999999" }), msg(2, { senderUin: "10002" }),
        msg(3, { chatType: 1 }), msg(4, { senderUid: "u_self" }), msg(5, { msgType: 5 }), msg(6)]);
    await until(() => !engine.busy && !engine.queue.length);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], [{ peer: { chatType: 2, peerUid: "12345678", guildId: "" }, msgSeq: "1006", emojiId: "128541", emojiType: "2", setEmoji: true }, null]);
    assert.equal(engine.stats.success, 1);
});

test("同条消息多次通知和重启重放均不会重复回应", async t => {
    const prefs = new memory_preferences();
    const { engine, sent } = setup(t, { preferences: prefs });
    const record = msg();
    engine.receive("x/onRecvMsg", [record, record]); engine.receive("x/onRecvActiveMsg", [structuredClone(record)]);
    await until(() => !engine.busy);
    const restarted = new reaction_engine({ preferences: prefs, catalog, send: async payload => { sent.push(payload); return { result: 0 }; } });
    t.after(() => restarted.dispose()); restarted.set_account("u_self");
    restarted.receive("x/onRecvMsg", [record]); await delay(5);
    assert.equal(sent.length, 1);
});

test("历史、离线补发、无时间、未来和早于启用边界的消息不会回应", async t => {
    const { engine, sent } = setup(t);
    engine.receive("x/getMsgList", [msg(1)]); engine.receive("x/onMsgInfoListUpdate", [msg(2)]);
    engine.receive("x/onRecvMsg", [msg(3, { isOnlineMsg: false }), msg(4, { msgTime: "0" }),
        msg(5, { msgTime: String(Math.floor(Date.now() / 1000) - 120) }), msg(6, { msgTime: String(Math.floor(Date.now() / 1000) + 120) })]);
    engine.configure({ ...config(), enabled: false }); engine.receive("x/onRecvMsg", [msg(7)]);
    engine.configure(config()); engine.receive("x/onRecvMsg", [msg(7)]);
    await delay(5); assert.equal(sent.length, 0);
});

test("串行发送并保持回应间隔，重发通知不增加队列", async t => {
    const times = [];
    const { engine } = setup(t, { interval_ms: 30, send: async () => { times.push(Date.now()); return { result: 0 }; } });
    engine.receive("x/onRecvMsg", [msg(1), msg(2), msg(3)]);
    engine.receive("x/onRecvMsg", [msg(2), msg(3)]);
    await until(() => times.length === 3 && !engine.busy);
    assert.ok(times[1] - times[0] >= 25); assert.ok(times[2] - times[1] >= 25);
});

test("失败暂停当前规则并持久保存，不重试；显式恢复只处理新消息", async t => {
    let calls = 0;
    const { engine } = setup(t, { send: async () => ({ result: ++calls === 1 ? 5 : 0 }) });
    engine.receive("x/onRecvMsg", [msg(1), msg(2)]);
    await until(() => !engine.busy && !engine.queue.length);
    assert.equal(calls, 1); assert.equal(engine.config.rules[0].enabled, false);
    assert.equal(engine.preferences.config("u_self").rules[0].enabled, false);
    assert.match(engine.errors.get("rule1"), /错误码 5/);
    engine.configure(config()); engine.receive("x/onRecvMsg", [msg(1), msg(3)]);
    await until(() => !engine.busy);
    assert.equal(calls, 2); assert.equal(engine.stats.success, 1);
});

test("关闭总开关会丢弃排队任务，账号切换后不沿用上一账号规则", async t => {
    let release; let calls = 0;
    const { engine } = setup(t, { send: async () => { calls++; await new Promise(resolve => { release = resolve; }); return { result: 0 }; } });
    engine.receive("x/onRecvMsg", [msg(1), msg(2), msg(3)]);
    await until(() => release);
    engine.configure({ ...config(), enabled: false }); release();
    await until(() => !engine.busy); assert.equal(calls, 1); assert.equal(engine.queue.length, 0);
    engine.set_account("u_other"); assert.equal(engine.config.enabled, false); assert.equal(engine.config.rules.length, 0);
    engine.receive("x/onRecvMsg", [msg(4)]); await delay(5); assert.equal(calls, 1);
});

test("去重记录无法写入时不发出回应", async t => {
    const prefs = new memory_preferences();
    prefs.write = (account, name, value) => { if (name === "processed") throw new Error("磁盘写入失败"); memory_preferences.prototype.write.call(prefs, account, name, value); };
    const { engine, sent } = setup(t, { preferences: prefs });
    engine.receive("x/onRecvMsg", [msg()]);
    await until(() => !engine.busy); assert.equal(sent.length, 0); assert.match(engine.errors.get("rule1"), /磁盘/);
});

test("突发消息队列有上限，关闭后不发送剩余任务", async t => {
    let release;
    const { engine, sent } = setup(t, { send: async payload => { sent.push(payload); await new Promise(resolve => { release = resolve; }); return { result: 0 }; } });
    engine.receive("x/onRecvMsg", Array.from({ length: 150 }, (_, index) => msg(index + 1)));
    assert.ok(engine.queue.length <= 100); assert.ok(engine.stats.skipped >= 49);
    engine.configure({ ...config(), enabled: false }); release(); await until(() => !engine.busy);
    assert.equal(sent.length, 1);
});

test("无效群号、重复目标和目录外表情被拒绝，未知回包不伪报成功", () => {
    assert.throws(() => validate_config({ ...config(), rules: [{ ...config().rules[0], group_id: "../../bad" }] }, catalog), /群号/);
    assert.throws(() => validate_config({ ...config(), rules: [config().rules[0], { ...config().rules[0], id: "rule2" }] }, catalog), /只需一条/);
    assert.throws(() => validate_config({ ...config(), rules: [{ ...config().rules[0], emoji_id: "999999" }] }, catalog), /表情目录/);
    assert.equal(check_result({ promiseStatue: "success", result: { result: 0 } }), true);
    assert.throws(() => check_result({ result: 0, errCode: 5 }), /错误码 5/);
    assert.throws(() => check_result({}), /没有明确/);
});

test("规则与去重文件按账号隔离；配置损坏时保留原文件", async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "target-reactor-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
    const prefs = new preferences(root); prefs.write("u_self", "rules", config()); prefs.write("u_self", "processed", ["key"]);
    assert.equal(prefs.config("u_self").enabled, true); assert.equal(prefs.config("u_other").enabled, false);
    assert.deepEqual(prefs.processed("u_self"), ["key"]); assert.throws(() => prefs.config("../bad"), /账号/);
    const file = prefs.file("u_self", "rules"); await fs.writeFile(file, "invalid json");
    assert.throws(() => prefs.config("u_self"), /原文件已保留/); assert.equal(await fs.readFile(file, "utf8"), "invalid json");
});

test("QQ 表情目录忽略隐藏项并区分 QQ 表情和 Unicode 回应", async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "target-emoji-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
    const directory = path.join(root, "app/resource/default-emojis"); await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "default_config.json"), JSON.stringify({ normalPanelResult: { SysEmojiGroupList: [{ SysEmojiList: [
        { emojiId: "4", describe: "/得意", emojiType: 0 }, { emojiId: "5", describe: "隐藏", isHide: true } ] }] } }));
    await fs.writeFile(path.join(directory, "4.png"), "fake png"); await fs.writeFile(path.join(directory, "5.png"), "fake png");
    const loaded = load_catalog({ resources: root, documents: root }); assert.equal(loaded.length, 1); assert.equal(loaded[0].type, "1");
});

test("原生请求经真实渲染进程桥接，回包必须匹配窗口与 callbackId", async () => {
    let observe; let sent;
    const peer = new EventEmitter(); Object.assign(peer, { id: 7, isDestroyed: () => false, getURL: () => "app://qq/#/main/message", send: (...args) => { sent = args; } });
    const transport = new native_transport({ ipc_main: { listenerCount: () => 1 }, web_contents: { getAllWebContents: () => [peer] },
        interceptor: { onIpcSend: callback => { observe = callback; } }, timeout_ms: 100 });
    const pending = transport.request([{ peer: { chatType: 2 }, setEmoji: true }, null]);
    assert.equal(sent[2].cmdName, "nodeIKernelMsgService/setMsgEmojiLikes");
    observe("RM_IPCFROM_MAIN8", sent[1], { result: 5 });
    assert.equal(transport.pending.size, 1);
    observe("RM_IPCFROM_MAIN7", sent[1], { result: 0 }); assert.deepEqual(await pending, { result: 0 });
    assert.equal(peer.listenerCount("destroyed"), 0); transport.dispose();
});

test("预加载桥接拒绝取消回应、私聊及任意原生命令", () => {
    let listener; const calls = []; let bridge;
    const electron = { contextBridge: { exposeInMainWorld: (_name, api) => { bridge = api; } }, ipcRenderer: {
        on: (_name, callback) => { listener = callback; }, send: (...args) => calls.push(args), invoke() {} } };
    vm.runInNewContext(fs_sync.readFileSync(path.join(__dirname, "../target-reactor/preload.js"), "utf8"), { require: () => electron });
    const header = { type: "request", eventName: "ntApi", peerId: 1, callbackId: "request" };
    const command = { cmdName: "nodeIKernelMsgService/setMsgEmojiLikes", cmdType: "invoke", payload: [{ peer: { chatType: 2, peerUid: "12345678" }, msgSeq: "90071992547409999", emojiId: "128541", emojiType: "2", setEmoji: true }, null] };
    listener({}, header, command); assert.equal(calls.length, 1);
    command.payload[0].setEmoji = false; listener({}, header, command);
    command.payload[0].setEmoji = true; command.payload[0].peer.chatType = 1; listener({}, header, command);
    command.payload[0].peer.chatType = 2; command.cmdName = "quitGroup"; listener({}, header, command);
    assert.equal(calls.length, 1); assert.deepEqual(Object.keys(bridge), ["state", "save", "changed"]);
});

test("主进程集成：登录、配置、接收、桥接回包和状态统计完整串联", async () => {
    const handlers = new Map(); let observe;
    const app = new EventEmitter(); app.getPath = () => "C:/test-documents";
    const peer = new EventEmitter(); Object.assign(peer, { id: 1, isDestroyed: () => false, getURL: () => "app://qq/#/main/message" });
    let native_calls = 0;
    peer.send = (_channel, header, command) => { native_calls++; queueMicrotask(() => observe("RM_IPCFROM_MAIN1", header, { result: 0 })); };
    const electron = { app, ipcMain: { handle: (name, handler) => handlers.set(name, handler), listenerCount: () => 1 },
        webContents: { getAllWebContents: () => [peer], fromId: id => id === 1 ? peer : null } };
    const context = { require: name => name === "electron" ? electron : name === "node:path" ? path
        : name === "./lib/preferences" ? { preferences: memory_preferences } : name === "./lib/emoji_catalog" ? { load_catalog: () => catalog }
            : require(path.join(__dirname, "../target-reactor", name)),
        globalThis: { IpcInterceptor: { onIpcSend: callback => { observe = callback; } } },
        module: { exports: {} }, LiteLoader: { path: { data: "C:/test" }, versions: { qqnt: "test" } },
        process: { execPath: "C:/test/QQ.exe", resourcesPath: "C:/test/resources" }, console, setTimeout, clearTimeout };
    vm.runInNewContext(fs_sync.readFileSync(path.join(__dirname, "../target-reactor/main.js"), "utf8"), context);
    context.module.exports.onLogin("u_self");
    const event = { sender: { getURL: () => "app://qq/#/setting/setting" } };
    const save = handlers.get("LiteLoader.target_reactor.save"); assert.equal((await save(event, config())).ok, true);
    observe("RM_IPCFROM_MAIN1", {}, { cmdName: "nodeIKernelMsgListener/onRecvMsg", payload: { msgList: [msg()] } });
    const state = handlers.get("LiteLoader.target_reactor.state");
    await until(async () => (await state(event, false)).data.stats.success === 1);
    const result = await state(event, true); assert.equal(result.data.stats.success, 1); assert.equal(native_calls, 1);
    assert.equal((await state({ sender: { getURL: () => "https://example.org/" } }, true)).ok, false);
    app.emit("before-quit");
});
