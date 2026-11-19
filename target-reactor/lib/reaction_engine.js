"use strict";

const { createHash } = require("node:crypto");
const { validate_config, reaction_request, check_result, message_time, valid_group } = require("./rules");

// 本模块拥有当前账号、启用边界、去重队列及回应状态；只消费新消息通知。
class reaction_engine {
    constructor({ preferences, catalog, send, publish = () => {}, now = Date.now, interval_ms = 800 }) {
        Object.assign(this, { preferences, catalog, send, publish, now, interval_ms });
        this.account = "";
        this.config = { enabled: false, rules: [] };
        this.epoch = 0;
        this.since = now();
        this.seen = new Set();
        this.processed = [];
        this.queue = [];
        this.errors = new Map();
        this.recent = new Map();
        this.events = [];
        this.stats = { success: 0, failed: 0, skipped: 0 };
        this.busy = false;
        this.next_at = 0;
        this.closed = false;
    }

    set_account(account) {
        if (account === this.account) return;
        if (typeof account !== "string" || !/^[\w-]{3,100}$/.test(account)) throw new Error("QQ 账号信息无效");
        this.epoch++;
        this.account = account;
        this.config = { enabled: false, rules: [] };
        this.queue = []; this.errors.clear(); this.recent.clear(); this.events = [];
        this.stats = { success: 0, failed: 0, skipped: 0 };
        this.seen = new Set(); this.processed = [];
        this.since = this.now();
        // 配置损坏或去重记录不可读时，保持关闭状态，不覆盖原文件。
        const config = validate_config(this.preferences.config(account), this.catalog);
        const processed = this.preferences.processed(account);
        this.config = config;
        this.processed = processed;
        this.seen = new Set(processed);
        this.publish();
    }

    configure(value) {
        if (!this.account) throw new Error("请先登录 QQ");
        const config = validate_config(value, this.catalog);
        this.preferences.write(this.account, "rules", config);
        this.config = config;
        this.epoch++; this.since = this.now(); this.queue = []; this.errors.clear();
        clearTimeout(this.timer);
        this.publish();
        return this.snapshot();
    }

    message_key(msg) {
        const identity = String(msg.msgId || "seq:" + msg.msgSeq);
        return createHash("sha256").update(JSON.stringify([this.account, String(msg.peerUid), identity])).digest("hex");
    }

    remember_sender(msg) {
        const group_id = String(msg.peerUin || msg.peerUid || "");
        if (!valid_group(group_id)) return;
        const member_id = String(msg.senderUin || msg.senderUid || "");
        let group = this.recent.get(group_id);
        if (!group) group = { id: group_id, name: String(msg.peerName || group_id).slice(0, 100), members: new Map() };
        group.members.delete(member_id);
        group.members.set(member_id, { id: member_id, name: String(msg.sendMemberName || msg.sendRemarkName || msg.sendNickName || member_id).slice(0, 100) });
        while (group.members.size > 256) group.members.delete(group.members.keys().next().value);
        this.recent.delete(group_id); this.recent.set(group_id, group);
        while (this.recent.size > 64) this.recent.delete(this.recent.keys().next().value);
    }

    receive(command, records) {
        if (this.closed || !this.account || !/\/(?:onRecvMsg|onRecvActiveMsg)$/.test(command) || !Array.isArray(records)) return;
        for (const msg of records.slice(0, 1000)) {
            if (!msg || Number(msg.chatType) !== 2 || Number(msg.msgType) === 5 || !msg.msgId || !/^\d+$/.test(String(msg.msgSeq || ""))) continue;
            if (msg.selfUid && msg.selfUid !== this.account) continue;
            this.remember_sender(msg);
            const key = this.message_key(msg);
            if (this.seen.has(key)) continue;
            this.seen.add(key);
            while (this.seen.size > 10000) this.seen.delete(this.seen.values().next().value);
            const time = message_time(msg);
            if (!this.config.enabled || Number(msg.sendType) === 1 || msg.senderUid === this.account || msg.isOnlineMsg === false ||
                !time || time < this.since - 999 || time < this.now() - 60000 || time > this.now() + 10000) continue;
            const rule = this.config.rules.find(item => item.enabled && !this.errors.has(item.id) &&
                [String(msg.peerUid), String(msg.peerUin || "")].includes(item.group_id) &&
                [String(msg.senderUid || ""), String(msg.senderUin || "")].includes(item.member_id));
            if (!rule) continue;
            if (this.queue.length >= 100) { this.stats.skipped++; this.record(rule, "skipped", "等待队列已满，已跳过此条"); continue; }
            this.queue.push({ key, msg: { msgId: String(msg.msgId), msgSeq: String(msg.msgSeq), peerUid: String(msg.peerUid), chatType: 2,
                msgTime: msg.msgTime }, rule, epoch: this.epoch, account: this.account });
        }
        this.drain();
    }

    record(rule, outcome, message) {
        this.events.unshift({ at: this.now(), rule_id: rule.id, group_id: rule.group_id, member_id: rule.member_id,
            emoji_id: rule.emoji_id, outcome, message });
        this.events.length = Math.min(20, this.events.length);
        this.publish();
    }

    drain() {
        if (this.closed || this.busy || !this.queue.length) return;
        const delay = this.next_at - this.now();
        if (delay > 0) {
            clearTimeout(this.timer);
            this.timer = setTimeout(() => this.drain(), delay);
            this.timer.unref?.();
            return;
        }
        const job = this.queue.shift();
        if (!this.config.enabled || job.epoch !== this.epoch || this.errors.has(job.rule.id) ||
            message_time(job.msg) < this.now() - 60000) {
            this.stats.skipped++; this.drain(); return;
        }
        this.busy = true;
        this.next_at = this.now() + this.interval_ms;
        void (async () => {
            try {
                const processed = [...this.processed, job.key].slice(-5000);
                // 先登记再发出，进程异常退出后也不会为同一条消息重复回应。
                this.preferences.write(job.account, "processed", processed);
                this.processed = processed;
                const result = await this.send(reaction_request(job.msg, job.rule));
                check_result(result);
                if (job.account === this.account) { this.stats.success++; this.record(job.rule, "success", "QQ 已确认表情回应"); }
            } catch (error) {
                if (job.account === this.account && job.epoch === this.epoch) {
                    this.stats.failed++; this.errors.set(job.rule.id, error.message);
                    this.config = { ...this.config, rules: this.config.rules.map(rule => rule.id === job.rule.id ? { ...rule, enabled: false } : rule) };
                    try { this.preferences.write(job.account, "rules", this.config); } catch { /* 写盘失败时仍保持内存中的暂停状态。 */ }
                    this.record(job.rule, "failed", error.message + "；此规则已暂停，未自动重试");
                }
            } finally {
                this.busy = false; this.publish(); this.drain();
            }
        })();
    }

    snapshot() {
        return { account: this.account, config: this.config, since: this.since, stats: { ...this.stats }, queued: this.queue.length,
            busy: this.busy, errors: Object.fromEntries(this.errors), events: this.events.slice(),
            recent: [...this.recent.values()].reverse().map(group => ({ id: group.id, name: group.name, members: [...group.members.values()].reverse() })) };
    }

    dispose() { this.closed = true; this.epoch++; this.queue = []; clearTimeout(this.timer); }
}

module.exports = { reaction_engine };
