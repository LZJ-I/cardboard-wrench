"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { open_group_script, open_group } = require("../group-cleaner/lib/group_actions.js");
const { NativeCalibration, make_template, instantiate_template, clears_records, payload_shape } = require("../group-cleaner/lib/native_calibration.js");
const { BatchManager } = require("../group-cleaner/lib/batch_manager.js");
const { NativeTransport } = require("../group-cleaner/lib/native_transport.js");
const { GroupClient } = require("../group-cleaner/lib/group_client.js");
const { extract_group_list, normalize_groups, blocked_reason } = require("../group-cleaner/lib/group_model.js");

const group = (id = "123456", changes = {}) => ({ id, name: `测试群 ${id}`, role_known: true, owner: false, retained: false, ...changes });

function fixture(options = {}) {
    let groups = [group(), group("234567")];
    let account = "u_test_account";
    const sent = [];
    const snapshots = [];
    const manager = new BatchManager({
        account: () => account,
        read_groups: async () => groups.map(item => ({ ...item })),
        requester_alive: () => true,
        delay: async () => {},
        publish: value => snapshots.push(value),
        confirm: async () => true,
        quit_group: async id => { sent.push(id); groups = groups.filter(item => item.id !== id); return { result: 0 }; },
        ...options
    });
    return { manager, sent, snapshots, set_groups: value => { groups = value; }, set_account: value => { account = value; } };
}

test("群列表支持 Map 和嵌套返回，不把成功 ACK 或详情当成空列表", () => {
    const raw = { groupCode: "123456", groupName: "例子", memberRole: 2 };
    assert.deepEqual(extract_group_list({ groupList: new Map([["123456", raw]]) }), [raw]);
    assert.deepEqual(extract_group_list([0, [raw]]), [raw]);
    assert.deepEqual(extract_group_list([]), []);
    assert.equal(extract_group_list({ result: 0, errMsg: "" }), null);
    assert.equal(extract_group_list(raw), null);
});

test("群主、保留群和未知身份默认阻止；群名不影响身份校验", () => {
    const groups = normalize_groups([
        { groupCode: "123456", groupName: "<img onerror=alert(1)>", memberRole: 4 },
        { groupCode: "234567", groupName: "保留", memberRole: 2 },
        { groupCode: "345678", groupName: "待确认" },
        { groupCode: "456789", groupName: "管理员", memberRole: 3 },
        { groupCode: "567890", groupName: "我是群主", memberRole: 2, groupOwnerId: { memberUid: "u_test" } }
    ], "u_test", ["234567"]);
    assert.ok(blocked_reason(groups[0]));
    assert.ok(blocked_reason(groups[1]));
    assert.ok(blocked_reason(groups[2]));
    assert.equal(blocked_reason(groups[3]), "");
    assert.ok(blocked_reason(groups[4]));
});

test("准备名单、拒绝确认不会发送任何退群请求", async () => {
    const f = fixture({ confirm: async () => false });
    const plan = await f.manager.prepare(["123456"], 42);
    assert.deepEqual(f.sent, []);
    assert.deepEqual(await f.manager.start(plan.token, 42), { cancelled: true });
    assert.deepEqual(f.sent, []);
    assert.equal(f.manager.busy, false);
});

test("确认 token 绑定发起窗口、账号、过期时间且只能使用一次", async () => {
    const f = fixture();
    let plan = await f.manager.prepare(["123456"], 42);
    await assert.rejects(f.manager.start(plan.token, 99), /过期/);
    await assert.rejects(f.manager.start(plan.token, 42), /过期/);
    plan = await f.manager.prepare(["123456"], 42);
    f.set_account("u_other");
    await assert.rejects(f.manager.start(plan.token, 42), /过期/);
    plan = await f.manager.prepare(["123456"], 42);
    f.manager.plan.expires_at = Date.now() - 1;
    await assert.rejects(f.manager.start(plan.token, 42), /过期/);
    assert.deepEqual(f.sent, []);
});

test("串行退出，只有确认群从完整列表消失后才显示成功", async () => {
    const f = fixture();
    const plan = await f.manager.prepare(["123456", "123456", "234567"], 42);
    await f.manager.start(plan.token, 42);
    await f.manager.running_task;
    assert.deepEqual(f.sent, ["123456", "234567"]);
    assert.deepEqual(f.manager.job.items.map(item => item.status), ["success", "success"]);
    assert.equal(f.manager.busy, false);
});

test("确认后再次复核，刚被保护的群会跳过", async () => {
    const f = fixture();
    const plan = await f.manager.prepare(["123456"], 42);
    f.set_groups([group("123456", { retained: true })]);
    await f.manager.start(plan.token, 42);
    await f.manager.running_task;
    assert.deepEqual(f.sent, []);
    assert.equal(f.manager.job.items[0].status, "skipped");
});

test("QQ 成功 ACK 但列表未确认时停止，不向下一群发请求", async () => {
    const sent = [];
    const f = fixture({ quit_group: async id => { sent.push(id); return { result: 0 }; } });
    const plan = await f.manager.prepare(["123456", "234567"], 42);
    await f.manager.start(plan.token, 42);
    await f.manager.running_task;
    assert.deepEqual(sent, ["123456"]);
    assert.deepEqual(f.manager.job.items.map(item => item.status), ["unknown", "cancelled"]);
});

test("超时或异常响应不重试，保留待核实状态", async () => {
    for (const response of [null, {}, { result: 5 }, { errCode: 0 }]) {
        const sent = [];
        const f = fixture({ quit_group: async id => { sent.push(id); return response; } });
        const plan = await f.manager.prepare(["123456", "234567"], 42);
        await f.manager.start(plan.token, 42);
        await f.manager.running_task;
        assert.deepEqual(sent, ["123456"]);
        assert.equal(f.manager.job.items[0].status, response?.result === 5 ? "failed" : "unknown");
    }
});

test("复核过程中点击停止，不发送已选群退出请求", async () => {
    let release;
    let reads = 0;
    const waiting = new Promise(resolve => { release = resolve; });
    const f = fixture({ read_groups: async () => { if (++reads === 2) await waiting; return [group()]; } });
    const plan = await f.manager.prepare(["123456"], 42);
    await f.manager.start(plan.token, 42);
    f.manager.stop(); release();
    await f.manager.running_task;
    assert.deepEqual(f.sent, []);
    assert.equal(f.manager.job.items[0].status, "cancelled");
});

test("账号在确认框期间改变，无法开始执行", async () => {
    let f;
    f = fixture({ confirm: async () => { f.set_account("u_other"); return true; } });
    const plan = await f.manager.prepare(["123456"], 42);
    await assert.rejects(f.manager.start(plan.token, 42), /切换/);
    assert.deepEqual(f.sent, []);
    assert.equal(f.manager.busy, false);
});

test("确认框期间停止任务，确认返回后也不会执行", async () => {
    let f;
    f = fixture({ confirm: async () => { f.manager.stop(); return true; } });
    const plan = await f.manager.prepare(["123456"], 42);
    await assert.rejects(f.manager.start(plan.token, 42), /停止/);
    assert.deepEqual(f.sent, []);
});

test("IPC 请求按 callbackId 和窗口匹配，超时清理观察状态", async () => {
    const ipc_main = new EventEmitter();
    const peer = new EventEmitter();
    Object.assign(peer, { id: 12, isDestroyed: () => false, getURL: () => "app://./renderer/index.html#/main/message" });
    let observe;
    const transport = new NativeTransport({
        ipc_main, web_contents: { getAllWebContents: () => [peer] }, timeout_ms: 20,
        interceptor: { onIpcSend: callback => { observe = callback; return () => {}; } }
    });
    ipc_main.on("RM_IPCFROM_RENDERER12", (_event, header, body) => {
        assert.equal(body.cmdName, "getGroupList");
        observe("RM_IPCFROM_MAIN99", header, { wrong: true });
        observe("RM_IPCFROM_MAIN12", { callbackId: "wrong" }, { wrong: true });
        observe("RM_IPCFROM_MAIN12", header, []);
    });
    assert.deepEqual(await transport.request("NodeStoreApi", "getGroupList", []), []);
    assert.equal(transport.pending.size, 0);
    ipc_main.removeAllListeners(); ipc_main.on("RM_IPCFROM_RENDERER12", () => {});
    await assert.rejects(transport.request("NodeStoreApi", "getGroupList", []), /超时/);
    assert.equal(transport.pending.size, 0);
    assert.equal(peer.listenerCount("destroyed"), 0);
    transport.dispose();
});

test("只读群列表回退忽略增量通知，等待完整群列表", async () => {
    let observer;
    const transport = {
        observe: callback => { observer = callback; },
        request: async (event_name) => {
            if (event_name === "NodeStoreApi") return { result: 0 };
            observer("channel", {}, { cmdName: "nodeIKernelGroupListener/onGroupListUpdate", payload: [2, [{ groupCode: "999999", groupName: "增量", memberRole: 2 }]] });
            observer("channel", {}, { cmdName: "nodeIKernelGroupListener/onGroupListUpdate", payload: [1, [{ groupCode: "123456", groupName: "完整", memberRole: 2 }]] });
            return { result: 0 };
        }
    };
    const client = new GroupClient(transport, { read: () => ({ retained: [] }) }, () => {});
    client.set_account("u_test");
    assert.deepEqual((await client.refresh()).map(item => item.id), ["123456"]);
    assert.equal(client.waiters.size, 0);
});

test("插件入口在模拟 Electron 中可加载，启动和查看面板不触发任何 QQ 原生请求", async () => {
    const handlers = new Map();
    const ipc_main = new EventEmitter();
    ipc_main.handle = (channel, handler) => handlers.set(channel, handler);
    let emitted = 0;
    const original_emit = ipc_main.emit.bind(ipc_main);
    ipc_main.emit = (...args) => { emitted++; return original_emit(...args); };
    const entry = path.resolve(__dirname, "../group-cleaner/main.js");
    const local_require = createRequire(entry);
    const module_object = { exports: {} };
    const context = {
        require: name => name === "electron" ? {
            ipcMain: ipc_main,
            webContents: { getAllWebContents: () => [], fromId: () => null },
            BrowserWindow: {}, dialog: { showMessageBox: () => { throw new Error("禁止在模拟测试中打开真实对话框"); } }
        } : local_require(name),
        module: module_object,
        LiteLoader: { path: { data: path.join(__dirname, "mock-data-not-created") }, versions: { qqnt: "mock" } },
        IpcInterceptor: { onIpcSend: () => () => {} },
        console
    };
    new vm.Script(fs.readFileSync(entry, "utf8"), { filename: entry }).runInNewContext(context);
    module_object.exports.onLogin("u_mock_test");
    const sender = { id: 1, getURL: () => "app://./renderer/index.html#/setting/settings/common" };
    const response = await handlers.get("LiteLoader.group_cleaner.state")({ sender });
    assert.equal(response.ok, true);
    assert.equal(response.data.account, "u_mock_test");
    assert.equal(response.data.groups.length, 0);
    const denied = await handlers.get("LiteLoader.group_cleaner.state")({ sender: { getURL: () => "https://example.org/" } });
    assert.equal(denied.ok, false);
    assert.equal(emitted, 0);
    assert.equal(handlers.size, 9);
    const invalid_group = await handlers.get("LiteLoader.group_cleaner.open_group")({ sender }, "123456");
    assert.equal(invalid_group.ok, false);
    assert.equal(emitted, 0);
    const uncalibrated = await handlers.get("LiteLoader.group_cleaner.prepare")({ sender }, ["123456"]);
    assert.equal(uncalibrated.ok, false);
    assert.match(uncalibrated.error, /校准/);
    assert.equal(emitted, 0);
});

test("原生模板只替换群号，拒绝其他操作、认证字段和混合群号；记录清理设置用于确认", () => {
    const header = { eventName: "ns-ntApi-7" };
    const command = { cmdName: "nodeIKernelGroupService/quitGroupV2", cmdType: "invoke", payload: [{ groupCode: "123456", needDeleteLocalMsg: false }, null] };
    const template = make_template(header, command, new Set(["123456"]));
    assert.equal(template.event_name, "ns-ntApi-{peer}");
    assert.ok(!JSON.stringify(template).includes("123456"));
    assert.deepEqual(instantiate_template(template, "234567"), [{ groupCode: "234567", needDeleteLocalMsg: false }, null]);
    assert.throws(() => make_template(header, { ...command, cmdName: "nodeIKernelGroupService/destroyGroup" }, new Set(["123456"])), /不支持/);
    assert.throws(() => make_template(header, { ...command, payload: [{ groupCode: "123456", authToken: "secret" }] }, new Set(["123456"])), /认证/);
    const with_clear = make_template(header, { ...command, payload: [{ groupCode: "123456", needDeleteLocalMsg: true }] }, new Set(["123456"]));
    assert.equal(clears_records(with_clear.payload), true);
    assert.throws(() => make_template(header, { ...command, payload: ["123456", "234567"] }, new Set(["123456", "234567"])), /唯一/);
    assert.throws(() => instantiate_template(template, '123456";alert(1)'), /无效/);
    assert.throws(() => instantiate_template({ ...template, payload: [{ groupCode: { $group_cleaner_target: "string" }, groupUin: "999999" }] }, "234567"), /独立群标识/);
});

test("跨 V8 上下文对象、null 原型、undefined 和 BigInt 经 JSON 落盘后无损复原", () => {
    const command = vm.runInNewContext(`({ cmdName: 'nodeIKernelGroupService/quitGroupV2', cmdType: 'invoke', payload: [{groupCode: '123456', needDeleteLocalMsg: true}, undefined, 0n] })`);
    const template = make_template({ eventName: "ntApi" }, command, new Set(["123456"]));
    const restored = instantiate_template(JSON.parse(JSON.stringify(template)), "234567");
    assert.deepEqual(restored, [{ groupCode: "234567", needDeleteLocalMsg: true }, undefined, 0n]);
    const null_prototype = Object.assign(Object.create(null), { groupCode: "123456" });
    const null_template = make_template({ eventName: "ntApi" }, { ...command, payload: [null_prototype] }, new Set(["123456"]));
    assert.deepEqual(instantiate_template(null_template, "234567"), [{ groupCode: "234567" }]);
});

test("类型诊断不记录群号、群名、凭证或聊天内容", () => {
    const diagnostic = payload_shape([{ groupCode: "123456", groupName: "私人群名", token: "private-token", flag: true }, undefined]);
    const encoded = JSON.stringify(diagnostic);
    assert.equal(encoded.includes("123456"), false);
    assert.equal(encoded.includes("私人群名"), false);
    assert.equal(encoded.includes("private-token"), false);
    assert.match(encoded, /undefined/);
    assert.deepEqual(diagnostic[0].flag, true);
});

test("QQ 返回错误码 4 会明确标为失败并停止后续队列", async () => {
    const calls = [];
    const f = fixture({ quit_group: async id => { calls.push(id); return { result: 4 }; } });
    const plan = await f.manager.prepare(["123456", "234567"], 42);
    await f.manager.start(plan.token, 42);
    await f.manager.running_task;
    assert.deepEqual(calls, ["123456"]);
    assert.equal(f.manager.job.items[0].status, "failed");
    assert.match(f.manager.job.items[0].message, /错误码 4/);
    assert.equal(f.manager.job.items[1].status, "cancelled");
});

test("点击群名只发送群聊天导航消息，不包含退群操作", async () => {
    const messages = [];
    let closed = false;
    let focused = false;
    const peer = {
        executeJavaScript: async source => vm.runInNewContext(source, {
            BroadcastChannel: class {
                constructor(name) { assert.equal(name, "MainWindow"); }
                postMessage(message) { messages.push(JSON.parse(JSON.stringify(message))); }
                close() { closed = true; }
            },
            crypto: { randomUUID: () => "mock-id" }
        }),
        focus: () => { focused = true; }
    };
    const window = { isDestroyed: () => false, isMinimized: () => false, show() {}, focus() {} };
    assert.deepEqual(await open_group({ find_peer: () => peer }, { fromWebContents: () => window }, "123456"), { opened: true });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].params.cmdName, "jumpNewAio");
    assert.equal(messages[0].params.args[0].chatType, 2);
    assert.equal(messages[0].params.args[0].peerUid, "123456");
    assert.equal(closed, true);
    assert.equal(focused, true);
    assert.throws(() => open_group_script('123456";alert(1)'), /无效/);
});

test("校准只观察用户原生操作，只有成功回包才保存，未验证前不发退群", async () => {
    let receive;
    let outgoing;
    const writes = [];
    const calls = [];
    const calibration = new NativeCalibration({
        interceptor: { onIpcReceive: callback => { receive = callback; return () => {}; } },
        transport: {
            observe: callback => { outgoing = callback; }, find_peer: () => ({ id: 12 }),
            request: async (...args) => { calls.push(args); return { result: 0 }; }
        },
        account: () => "u_mock", groups: () => [{ id: "123456" }],
        data_path: "/mock", qq_version: "mock-version", publish: () => {},
        storage: { readFileSync() { throw new Error("ENOENT"); }, mkdirSync() {}, renameSync() {}, writeFileSync: (file, value) => writes.push({ file, value }) }
    });
    const templates = () => writes.filter(write => write.file.endsWith("native-quit-template.json.tmp"));
    assert.throws(() => calibration.request_quit("234567"), /校准/);
    calibration.begin();
    const header = { eventName: "ns-ntApi-7", peerId: 7, callbackId: "user-call" };
    const command = { cmdName: "nodeIKernelGroupService/quitGroupV2", cmdType: "invoke", payload: [{ groupCode: "123456", needDeleteLocalMsg: false }] };
    receive({}, false, "RM_IPCFROM_RENDERER7", [header, command]);
    outgoing("RM_IPCFROM_MAIN7", header, { result: 5 });
    assert.equal(templates().length, 0);
    assert.equal(calibration.snapshot().ready, false);
    receive({}, false, "RM_IPCFROM_RENDERER7", [header, command]);
    outgoing("RM_IPCFROM_MAIN7", { callbackId: "wrong" }, { result: 0 });
    assert.equal(templates().length, 0);
    outgoing("RM_IPCFROM_MAIN7", header, { result: 0 });
    assert.equal(templates().length, 1);
    assert.ok(writes.every(write => !write.value.includes("123456")));
    assert.equal(calibration.snapshot().ready, true);
    assert.equal(calibration.snapshot().active, false);
    assert.deepEqual(calls, []);
    await calibration.request_quit("234567");
    assert.deepEqual(calls, [["ns-ntApi-12", "nodeIKernelGroupService/quitGroupV2", [{ groupCode: "234567", needDeleteLocalMsg: false }], "invoke"]]);
});

test("真实渲染桥接分发保留请求身份，并且不走伪造主进程事件", async () => {
    let observe;
    const peer = new EventEmitter();
    Object.assign(peer, { id: 12, isDestroyed: () => false, getURL: () => "app://./renderer/index.html#/main/message" });
    const ipc_main = new EventEmitter();
    ipc_main.on("RM_IPCFROM_RENDERER12", () => { throw new Error("不应走主进程模拟事件"); });
    let dispatch_count = 0;
    const transport = new NativeTransport({
        ipc_main, web_contents: { getAllWebContents: () => [peer] },
        interceptor: { onIpcSend: callback => { observe = callback; return () => {}; } },
        dispatch: (target, header, command) => {
            assert.equal(target, peer);
            assert.equal(header.peerId, 12);
            assert.equal(command.cmdName, "getGroupList");
            dispatch_count++;
            observe("RM_IPCFROM_MAIN12", header, []);
        }
    });
    assert.deepEqual(await transport.request("NodeStoreApi", "getGroupList", []), []);
    assert.equal(dispatch_count, 1);
    transport.dispose();
});

test("当前 QQ 默认适配无需校准；失败后暂停且重启保持暂停", async () => {
    const stored = new Map();
    const calls = [];
    const options = {
        interceptor: { onIpcReceive: () => () => {} },
        transport: { observe() {}, find_peer: () => ({ id: 12 }), request: async (...args) => { calls.push(args); return { result: 5 }; } },
        account: () => "u_mock", groups: () => [], data_path: "/mock", qq_version: "9.9.37-54395", publish() {},
        storage: { readFileSync(file) { if (!stored.has(file)) throw Error("ENOENT"); return stored.get(file); }, mkdirSync() {}, writeFileSync: (file, value) => stored.set(file, value) }
    };
    const adapter = new NativeCalibration(options);
    assert.equal(adapter.snapshot().ready, true);
    assert.equal(adapter.snapshot().source, "builtin");
    const response = await adapter.request_quit("234567");
    assert.equal(response.needs_calibration, true);
    assert.deepEqual(calls[0], ["ntApi", "nodeIKernelGroupService/quitGroup", [{ groupCode: "234567" }, undefined], "invoke"]);
    assert.equal(adapter.snapshot().ready, false);
    const restarted = new NativeCalibration(options);
    assert.equal(restarted.snapshot().ready, false);
    assert.throws(() => restarted.request_quit("234567"), /校准/);
});
