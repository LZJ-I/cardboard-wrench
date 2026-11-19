"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { valid_group_id } = require("./group_model.js");
const { default_template } = require("./default_adapter.js");

const allowed_commands = new Set([
    "nodeIKernelGroupService/quitGroup", "nodeIKernelGroupService/quitGroupV2", "quitGroup", "quitGroupV2"
]);
const target_key = "$group_cleaner_target";
const value_key = "$group_cleaner_value";
const undefined_value = Symbol("undefined-value");

function map_payload(value, transform, depth = 0, field_path = "payload") {
    if (depth > 8) throw new Error("原生参数层级过深");
    const replacement = transform(value);
    if (replacement !== undefined) return replacement === undefined_value ? undefined : replacement;
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") {
        if (value === "" || /^(?:\d{1,20}|group|normal)$/.test(value)) return value;
        throw new Error("原生参数包含不能复用的文本字段，未保存");
    }
    if (Array.isArray(value)) return Array.from(value, (item, index) => map_payload(item, transform, depth + 1, `${field_path}[${index}]`));
    // Electron IPC 中的普通对象可能来自其他 V8 上下文，不能比较原型对象的身份。
    if (!value || typeof value !== "object" || Object.prototype.toString.call(value) !== "[object Object]") {
        throw new Error(`不支持的原生参数格式：${field_path}（${value === undefined ? "undefined" : Object.prototype.toString.call(value)}）`);
    }
    const result = {};
    for (const [key, child] of Object.entries(value)) {
        if (/token|ticket|password|secret|signature|credential|pskey|skey|__proto__|constructor|prototype/i.test(key)) throw new Error("原生请求包含认证字段，未保存");
        result[key] = map_payload(child, transform, depth + 1, `${field_path}.${key}`);
    }
    return result;
}

function clears_records(value) {
    if (!value || typeof value !== "object") return false;
    return Object.entries(value).some(([key, child]) =>
        (/delete|clear/i.test(key) && (child === true || child === 1)) || clears_records(child));
}

function payload_shape(value, depth = 0) {
    if (depth > 7) return "<depth-limit>";
    if (value === null) return "null";
    if (typeof value === "boolean") return value;
    if (["undefined", "number", "bigint", "string", "function"].includes(typeof value)) return `<${typeof value}>`;
    if (Array.isArray(value)) return Array.from(value, item => payload_shape(item, depth + 1));
    if (Object.prototype.toString.call(value) !== "[object Object]") return Object.prototype.toString.call(value);
    const shape = {};
    for (const [key, child] of Object.entries(value).slice(0, 50)) {
        const safe_key = /^[a-zA-Z_$][\w$]{0,80}$/.test(key) && !["__proto__", "constructor", "prototype"].includes(key) ? key : "<key>";
        shape[safe_key] = payload_shape(child, depth + 1);
    }
    return shape;
}

function make_template(header, command, group_ids) {
    if (!allowed_commands.has(command?.cmdName) || !["invoke", "ntApi"].includes(command.cmdType) || !Array.isArray(command.payload)) throw new Error("暂不支持这类原生退群调用");
    const event_name = String(header.eventName ?? "").replace(/-\d+$/, "-{peer}");
    if (!/^(?:ntApi|NodeStoreApi|ns-ntApi-\{peer\}|ns-NodeStoreApi-\{peer\})$/.test(event_name)) throw new Error("暂不支持这个原生调用通道");
    const ids = new Set();
    const payload = map_payload(command.payload, value => {
        if (["string", "number", "bigint"].includes(typeof value) && group_ids.has(String(value))) {
            ids.add(String(value));
            return { [target_key]: typeof value };
        }
        if (value === undefined) return { [value_key]: "undefined" };
        if (typeof value === "bigint") return { [value_key]: "bigint", value: value.toString() };
    });
    if (ids.size !== 1) throw new Error("无法唯一确定原生操作中的群号，未保存");
    const template = { event_name, command: command.cmdName, cmd_type: command.cmdType, payload };
    if (JSON.stringify(template).length > 8192) throw new Error("原生参数过长，未保存");
    instantiate_template(template, [...ids][0]);
    return template;
}

function instantiate_template(template, group_id) {
    if (!valid_group_id(group_id) || !allowed_commands.has(template?.command) || !["invoke", "ntApi"].includes(template.cmd_type) ||
        !/^(?:ntApi|NodeStoreApi|ns-ntApi-\{peer\}|ns-NodeStoreApi-\{peer\})$/.test(template.event_name)) throw new Error("校准数据无效，请重新校准");
    let targets = 0;
    const payload = map_payload(template.payload, value => {
        if (value && typeof value === "object" && Object.keys(value).length === 1 && Object.hasOwn(value, target_key)) {
            targets++;
            if (value[target_key] === "string") return group_id;
            if (value[target_key] === "number" && Number.isSafeInteger(Number(group_id))) return Number(group_id);
            if (value[target_key] === "bigint") return BigInt(group_id);
            throw new Error("校准群号类型无效");
        }
        if (value && typeof value === "object" && value[value_key] === "undefined" && Object.keys(value).length === 1) return undefined_value;
        if (value && typeof value === "object" && value[value_key] === "bigint" && Object.keys(value).length === 2 && /^-?\d{1,30}$/.test(value.value)) return BigInt(value.value);
    });
    if (!targets) throw new Error("校准数据中没有目标群号");
    function check_identity(value) {
        if (!value || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
            if (/^(?:groupCode|groupId|groupUin|peerUid|peerUin)$/i.test(key) && String(child) !== group_id) {
                throw new Error("原生请求含有独立群标识，暂不能安全复用");
            }
            check_identity(child);
        }
    }
    check_identity(payload);
    return payload;
}

// 此模块仅在用户开启校准后观察原生退群；保存的是成功调用的无账号参数模板。
class NativeCalibration {
    constructor({ interceptor, transport, account, groups, data_path, qq_version, publish, storage = fs }) {
        this.transport = transport;
        this.account = account;
        this.groups = groups;
        this.publish = publish;
        this.qq_version = qq_version;
        this.storage = storage;
        this.file = path.join(data_path, "native-quit-template.json");
        this.diagnostic_file = path.join(data_path, "native-quit-diagnostic.json");
        this.adapter_state_file = path.join(data_path, "native-adapter-state.json");
        this.template = null;
        this.source = "none";
        this.active = false;
        this.message = "首次使用请先校准一次原生退群操作。";
        this.pending = null;
        try {
            const saved = JSON.parse(storage.readFileSync(this.file, "utf8"));
            if (saved.qq_version === qq_version) {
                instantiate_template(saved.template, "123456");
                this.template = saved.template;
                this.source = "manual";
                this.message = "已加载本版本 QQ 的原生退群校准。";
            }
        } catch { /* 无已验证模板时，保持退群不可用。 */ }
        if (!this.template) {
            this.template = default_template(qq_version);
            if (this.template) { this.source = "builtin"; this.message = "当前 QQ 默认退群适配已就绪，无需手动校准。"; }
        }
        try {
            const saved_state = JSON.parse(storage.readFileSync(this.adapter_state_file, "utf8"));
            if (saved_state.qq_version === qq_version && saved_state.disabled) {
                this.template = null; this.source = "none";
                this.message = "上次退群调用失败，适配已暂停；请手动校准一次。";
            }
        } catch { }
        this.unsubscribe_receive = interceptor.onIpcReceive?.((_event, _frame, channel, args) => {
            if (!this.active || this.account() !== this.active_account || !/^RM_IPCFROM_RENDERER\d+$/.test(String(channel))) return;
            const [header, command] = Array.isArray(args) ? args : [];
            if (!allowed_commands.has(command?.cmdName)) return;
            const diagnostic = {
                qq_version, command: command.cmdName, cmd_type: command.cmdType,
                payload_shape: payload_shape(command.payload), phase: "request"
            };
            try {
                const template = make_template(header, command, new Set(this.groups().map(group => group.id)));
                this.pending = { callback_id: header.callbackId, peer_id: header.peerId, template, diagnostic };
                this.message = "已观察到原生退群请求，等待 QQ 确认结果…";
            } catch (error) {
                diagnostic.error = error.message;
                this.pending = { callback_id: header.callbackId, peer_id: header.peerId, template: null, diagnostic };
                this.message = `${error.message}；正在等待原生操作结果。`;
            }
            this.save_diagnostic(diagnostic);
            this.publish(this.snapshot());
        });
        this.unsubscribe_send = transport.observe((channel, header, response) => {
            const pending = this.pending;
            if (!this.active || this.account() !== this.active_account || !pending ||
                header?.callbackId !== pending.callback_id || channel !== `RM_IPCFROM_MAIN${pending.peer_id}`) return;
            this.pending = null;
            this.save_diagnostic({ ...pending.diagnostic, phase: "response", result: response?.result ?? "unknown" });
            if (response?.result !== 0) {
                this.message = `原生退群返回 ${response?.result ?? "未知结果"}，没有保存校准。`;
                this.publish(this.snapshot());
                return;
            }
            if (!pending.template) {
                this.finish(`QQ 原生退群已成功，但校准解析失败：${pending.diagnostic.error}。类型诊断已保存。`);
                return;
            }
            try {
                storage.mkdirSync(path.dirname(this.file), { recursive: true });
                const temporary = this.file + ".tmp";
                storage.writeFileSync(temporary, JSON.stringify({ qq_version, template: pending.template }, null, 2), "utf8");
                storage.renameSync(temporary, this.file);
                this.template = pending.template;
                this.source = "manual";
                storage.writeFileSync(this.adapter_state_file, JSON.stringify({ qq_version, disabled: false }), "utf8");
                this.finish(clears_records(this.template.payload) ?
                    "校准成功。原生参数包含清理记录设置，退群确认时会明确提示。请刷新群列表。" :
                    "校准成功。刷新群列表后即可使用插件退群。");
            } catch (error) { this.finish(`保存校准失败：${error.message}`); }
        });
    }

    save_diagnostic(diagnostic) {
        try {
            this.storage.mkdirSync(path.dirname(this.diagnostic_file), { recursive: true });
            this.storage.writeFileSync(this.diagnostic_file, JSON.stringify(diagnostic, null, 2), "utf8");
        } catch { /* 诊断失败不影响用户的原生退群操作。 */ }
    }

    begin() {
        if (!this.account() || !this.groups().length) throw new Error("请先刷新群列表，再开始校准");
        if (!this.unsubscribe_receive) throw new Error("当前 IPC 前置插件不能观察原生请求，请检查依赖是否启用");
        this.active = true;
        this.active_account = this.account();
        this.pending = null;
        clearTimeout(this.timer);
        this.expires_at = Date.now() + 180000;
        this.message = "请在 3 分钟内，用 QQ 自带按钮退出一个你确实要退的群；界面没有额外选项也可正常操作。";
        this.timer = setTimeout(() => this.finish("校准等待已结束，没有执行任何额外退群操作。"), 180000);
        this.timer.unref?.();
        this.publish(this.snapshot());
        return this.snapshot();
    }

    finish(message = "已停止校准。") {
        clearTimeout(this.timer);
        this.active = false;
        this.pending = null;
        this.message = message;
        this.publish(this.snapshot());
    }

    snapshot() {
        return { ready: Boolean(this.template), active: this.active, message: this.message, expires_at: this.active ? this.expires_at : 0,
            source: this.source, clears_records: Boolean(this.template && clears_records(this.template.payload)) };
    }

    request_quit(group_id) {
        if (this.active) throw new Error("请先完成或停止校准");
        if (!this.template) throw new Error("请先用 QQ 原生按钮校准退群操作");
        const payload = instantiate_template(this.template, group_id);
        const peer = this.transport.find_peer();
        const event_name = this.template.event_name.replace("{peer}", String(peer.id));
        try {
            return Promise.resolve(this.transport.request(event_name, this.template.command, payload, this.template.cmd_type))
                .then(response => {
                    if (!response || response.result !== 0) {
                        this.invalidate();
                        if (response && typeof response === "object") return { ...response, needs_calibration: true };
                    }
                    return response;
                }, error => { this.invalidate(); throw error; });
        } catch (error) { this.invalidate(); throw error; }
    }

    invalidate() {
        this.template = null;
        this.source = "none";
        this.message = "退群调用未成功，队列已暂停；请手动校准当前 QQ 的原生退群操作。";
        try {
            this.storage.mkdirSync(path.dirname(this.adapter_state_file), { recursive: true });
            this.storage.writeFileSync(this.adapter_state_file, JSON.stringify({ qq_version: this.qq_version, disabled: true }), "utf8");
        } catch { }
        this.publish(this.snapshot());
    }
}

module.exports = { NativeCalibration, make_template, instantiate_template, clears_records, payload_shape };
