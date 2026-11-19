"use strict";

// 本模块仅验证规则和组装已限定的表情回应请求，不持有运行状态。
function valid_group(value) { return typeof value === "string" && /^[1-9]\d{3,19}$/.test(value); }
function valid_member(value) { return typeof value === "string" && /^(?:[1-9]\d{3,19}|u_[\w-]{4,100})$/.test(value); }

function validate_config(value, catalog) {
    if (!value || typeof value.enabled !== "boolean" || !Array.isArray(value.rules) || value.rules.length > 100) throw new Error("规则格式异常，最多保存 100 条");
    const ids = new Set();
    const targets = new Set();
    const rules = value.rules.map(rule => {
        if (typeof rule.id !== "string" || !/^[\w-]{1,80}$/.test(rule.id) || ids.has(rule.id)) throw new Error("规则编号无效或重复");
        const group_id = String(rule.group_id || "").trim();
        const member_id = String(rule.member_id || "").trim();
        if (!valid_group(group_id)) throw new Error("请输入正确的群号");
        if (!valid_member(member_id)) throw new Error("请输入正确的成员 QQ 号或 QQ UID");
        const emoji = catalog.find(item => item.id === rule.emoji_id);
        if (!emoji) throw new Error("所选表情不在当前 QQ 表情目录中，请重新选择");
        const target = group_id + ":" + member_id;
        if (targets.has(target)) throw new Error("同一群内的同一成员只需一条规则，请修改已有规则");
        ids.add(rule.id); targets.add(target);
        return { id: rule.id, group_id, member_id, emoji_id: emoji.id, emoji_type: emoji.type,
            label: String(rule.label || "").slice(0, 100), enabled: rule.enabled === true };
    });
    return { enabled: value.enabled, rules };
}

function message_time(msg) {
    const value = Number(msg?.msgTime);
    return Number.isFinite(value) && value > 0 ? (value < 1e12 ? value * 1000 : value) : 0;
}

function reaction_request(msg, rule) {
    if (Number(msg.chatType) !== 2 || !/^\d+$/.test(String(msg.msgSeq || "")) || !valid_group(String(msg.peerUid || ""))) throw new Error("群消息身份不完整");
    return [{ peer: { chatType: 2, peerUid: String(msg.peerUid), guildId: "" },
        msgSeq: String(msg.msgSeq), emojiId: rule.emoji_id, emojiType: rule.emoji_type, setEmoji: true }, null];
}

function check_result(value) {
    const walk = (item, depth = 0) => {
        if (depth > 5 || item === null || item === undefined) return null;
        if (Array.isArray(item)) { for (const child of item) { const result = walk(child, depth + 1); if (result !== null) return result; } return null; }
        if (typeof item !== "object") return null;
        if (item.promiseStatus === "fail" || item.promiseStatue === "fail") throw new Error(String(item.errMsg || item.message || "QQ 拒绝了表情回应"));
        let explicit_success = false;
        for (const key of ["result", "retCode", "errCode", "code"]) {
            if (typeof item[key] === "number") {
                if (item[key] !== 0) throw new Error(`QQ 返回错误码 ${item[key]}${item.errMsg ? "：" + item.errMsg : ""}`);
                explicit_success = true;
            }
        }
        for (const key of ["payload", "result", "data", "value"]) {
            const result = walk(item[key], depth + 1); if (result !== null) return result;
        }
        if (explicit_success || item.promiseStatus === "success" || item.promiseStatue === "success") return true;
        return null;
    };
    if (walk(value) !== true) throw new Error("QQ 回包没有明确成功结果，请手动回应一次确认当前版本接口");
    return true;
}

module.exports = { valid_group, valid_member, validate_config, message_time, reaction_request, check_result };
