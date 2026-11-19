"use strict";

const { extract_group_list, normalize_groups } = require("./group_model.js");

// 本模块拥有当前账号及最近一次完整群列表；不将增量通知当成完整名单。
class GroupClient {
    constructor(transport, preferences, on_account_change) {
        this.transport = transport;
        this.preferences = preferences;
        this.on_account_change = on_account_change;
        this.account_uid = "";
        this.groups = [];
        this.updated_at = 0;
        this.waiters = new Set();
        transport.observe((_channel, _header, body) => {
            for (const event of Array.isArray(body) ? body : [body]) {
                if (event?.cmdName !== "nodeIKernelGroupListener/onGroupListUpdate") continue;
                const payload = event.payload;
                const update_type = Array.isArray(payload) ? payload[0] : payload?.updateType;
                if (update_type !== 0 && update_type !== 1) continue;
                const groups = extract_group_list(Array.isArray(payload) ? payload[1] : payload);
                if (groups !== null) for (const waiter of [...this.waiters]) waiter.resolve(groups);
            }
        });
    }

    set_account(uid) {
        if (typeof uid !== "string" || !/^[\w-]{3,100}$/.test(uid) || uid === this.account_uid) return;
        this.account_uid = uid;
        this.groups = [];
        this.updated_at = 0;
        for (const waiter of [...this.waiters]) waiter.reject(new Error("QQ 账号已切换"));
        this.on_account_change();
    }

    async refresh() {
        if (!this.account_uid) throw new Error("尚未收到 QQ 登录信息，请登录后再打开面板");
        if (this.refresh_task) return this.refresh_task;
        const account = this.account_uid;
        this.refresh_task = this.fetch_groups().then(raw_groups => {
            if (account !== this.account_uid) throw new Error("账号已切换，请重新刷新");
            const preferences = this.preferences.read(account);
            this.groups = normalize_groups(raw_groups, account, preferences.retained);
            this.updated_at = Date.now();
            return this.groups;
        }).finally(() => { this.refresh_task = null; });
        return this.refresh_task;
    }

    async fetch_groups() {
        try {
            const response = await this.transport.request("NodeStoreApi", "getGroupList", []);
            const groups = extract_group_list(response);
            if (groups !== null) return groups;
        } catch { /* 只读缓存接口不可用时，通过群服务取得完整列表。 */ }
        let waiter;
        const full_list = new Promise((resolve, reject) => {
            const timer = setTimeout(() => waiter.reject(new Error("读取完整群列表超时，请先打开 QQ 联系人的群聊列表再刷新")), 14000);
            const finish = (error, groups) => {
                if (!this.waiters.delete(waiter)) return;
                clearTimeout(timer);
                error ? reject(error) : resolve(groups);
            };
            waiter = { resolve: groups => finish(null, groups), reject: error => finish(error) };
            this.waiters.add(waiter);
        });
        // 立即订阅拒绝，避免通知先超时而 request 尚未结束时出现未处理拒绝。
        full_list.catch(() => {});
        try {
            const response = await this.transport.request("ntApi", "nodeIKernelGroupService/getGroupList", [true]);
            if (response?.result != null && response.result !== 0) throw new Error(`读取群列表失败：${response.errMsg || response.result}`);
            const direct = extract_group_list(response);
            if (direct !== null) waiter.resolve(direct);
            return await full_list;
        } catch (error) {
            waiter.reject(error);
            throw error;
        }
    }

    snapshot() {
        if (!this.account_uid) return { groups: [], updated_at: 0 };
        const retained = new Set(this.preferences.read(this.account_uid).retained);
        return {
            groups: this.groups.map(group => ({ ...group, retained: retained.has(group.id) })),
            updated_at: this.updated_at
        };
    }
}

module.exports = { GroupClient };
