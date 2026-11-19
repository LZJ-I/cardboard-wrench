"use strict";

const { randomUUID } = require("node:crypto");
const { valid_group_id, blocked_reason } = require("./group_model.js");

// 只持有当前进程中的退群计划和单条串行执行状态；重启不会恢复任务。
class BatchManager {
    constructor(services) {
        this.services = services;
        this.plan = null;
        this.job = null;
        this.busy = false;
        this.revision = 0;
    }

    async prepare(group_ids, requester_id) {
        if (this.busy) throw new Error("已有退群任务，请先等待完成或停止");
        if (!Array.isArray(group_ids) || !group_ids.length || group_ids.length > 200 ||
            group_ids.some(id => !valid_group_id(id))) throw new Error("请选择 1～200 个有效群聊");
        const revision = ++this.revision;
        const account = this.services.account();
        if (!account) throw new Error("请先登录 QQ");
        const groups = await this.services.read_groups();
        if (account !== this.services.account() || revision !== this.revision) throw new Error("账号或选择已变化，请重新选择");
        const by_id = new Map(groups.map(group => [group.id, group]));
        const selected = [...new Set(group_ids)].map(id => {
            const group = by_id.get(id);
            const reason = blocked_reason(group);
            if (reason) throw new Error(`${group?.name ?? id}：${reason}`);
            return { id, name: group.name };
        });
        const token = randomUUID();
        this.plan = { token, account, requester_id, groups: selected, expires_at: Date.now() + 90000 };
        return { token, groups: selected };
    }

    async start(token, requester_id) {
        if (this.busy) throw new Error("已有任务正在执行");
        const plan = this.plan;
        this.plan = null;
        if (!plan || token !== plan.token || requester_id !== plan.requester_id ||
            plan.expires_at < Date.now() || plan.account !== this.services.account()) {
            throw new Error("确认名单已过期，请重新选择");
        }
        this.busy = true;
        const revision = this.revision;
        try {
            if (!await this.services.confirm(plan)) return { cancelled: true };
            if (revision !== this.revision) throw new Error("操作已停止，请重新选择");
            if (plan.account !== this.services.account()) throw new Error("账号已切换，操作已取消");
            this.job = {
                id: randomUUID(), account: plan.account, requester_id,
                running: true, stop_requested: false,
                total: plan.groups.length, completed: 0,
                items: plan.groups.map(group => ({ ...group, status: "queued", message: "等待执行" }))
            };
            this.publish();
            this.running_task = this.run(this.job).catch(error => {
                this.job.error = error.message;
            }).finally(() => {
                this.job.running = false;
                this.busy = false;
                this.publish();
            });
            return { job_id: this.job.id };
        } finally {
            if (!this.job?.running) this.busy = false;
        }
    }

    async run(job) {
        for (const item of job.items) {
            if (job.stop_requested || this.services.account() !== job.account ||
                !this.services.requester_alive(job.requester_id)) break;
            try {
                item.status = "checking";
                item.message = "正在复核群身份与保留标记";
                this.publish();
                const groups = await this.services.read_groups();
                if (job.stop_requested || this.services.account() !== job.account ||
                    !this.services.requester_alive(job.requester_id)) break;
                const group = groups.find(group => group.id === item.id);
                const reason = blocked_reason(group);
                if (reason) {
                    item.status = "skipped";
                    item.message = reason;
                    job.completed++;
                    this.publish();
                    continue;
                }
                item.status = "leaving";
                item.message = "等待 QQ 返回结果";
                this.publish();
                // 每个群最多发送一次退出请求；超时后停止队列，交给用户核实。
                const response = await this.services.quit_group(item.id);
                if (response && typeof response === "object" && typeof response.result === "number" && response.result !== 0) {
                    item.status = "failed";
                    item.message = `退群失败：QQ 返回错误码 ${response.result}${response.errMsg ? "（" + response.errMsg + "）" : ""}；未自动重试${response.needs_calibration ? "。请手动校准当前 QQ 的退群适配" : ""}`;
                    job.stop_requested = true;
                    job.completed++;
                    this.publish();
                    break;
                }
                if (!response || typeof response !== "object" || response.result !== 0) {
                    const code = response?.result ?? response?.errCode ?? "未知";
                    throw new Error(`QQ 返回失败（${code}）${response?.errMsg ? "：" + response.errMsg : ""}`);
                }
                let absent = false;
                for (let attempt = 0; attempt < 3; attempt++) {
                    await this.services.delay(600);
                    if (this.services.account() !== job.account) break;
                    const current_groups = await this.services.read_groups();
                    if (!current_groups.some(group => group.id === item.id)) { absent = true; break; }
                }
                item.status = absent ? "success" : "unknown";
                item.message = absent ? "已退出" : "QQ 已受理，但群列表尚未确认，请刷新核实";
                if (!absent) job.stop_requested = true;
            } catch (error) {
                item.status = "unknown";
                item.message = `${error.message}；请先刷新核实，未自动重试`;
                job.stop_requested = true;
            }
            job.completed++;
            this.publish();
            if (!job.stop_requested) await this.services.delay(800);
        }
        for (const item of job.items) {
            if (["queued", "checking"].includes(item.status)) {
                item.status = "cancelled";
                item.message = "未执行";
            }
        }
    }

    stop() {
        if (this.job?.running) this.job.stop_requested = true;
        this.plan = null;
        this.revision++;
        this.publish();
        return { ok: true };
    }

    snapshot() {
        if (!this.job || this.job.account !== this.services.account()) return null;
        return JSON.parse(JSON.stringify(this.job));
    }

    publish() { this.services.publish(this.snapshot()); }
}

module.exports = { BatchManager };
