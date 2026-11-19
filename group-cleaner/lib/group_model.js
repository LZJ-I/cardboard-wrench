"use strict";

// 只负责群列表结构归一化和可操作性判断，不持有 QQ 会话。
function valid_group_id(value) {
    return typeof value === "string" && /^[1-9]\d{3,19}$/.test(value);
}

function extract_group_list(value, depth = 0) {
    if (depth > 5 || value == null) return null;
    if (value instanceof Map) {
        const entries = [...value.values()];
        return entries.every(is_group) ? entries : null;
    }
    if (Array.isArray(value)) {
        if (value.every(is_group)) return value;
        for (const item of value) {
            const found = extract_group_list(item, depth + 1);
            if (found !== null) return found;
        }
        return null;
    }
    if (typeof value !== "object") return null;
    for (const key of ["groupList", "groupInfos", "groups", "data", "list", "result"]) {
        if (Object.hasOwn(value, key)) {
            const found = extract_group_list(value[key], depth + 1);
            if (found !== null) return found;
        }
    }
    const entries = Object.values(value);
    if (entries.length && entries.every(is_group)) return entries;
    return null;
}

function is_group(value) {
    return value && typeof value === "object" && valid_group_id(String(value.groupCode ?? "")) &&
        (typeof value.groupName === "string" || typeof value.remarkName === "string");
}

function normalize_groups(raw_groups, account_uid, retained_ids = []) {
    const retained = new Set(retained_ids);
    const groups = new Map();
    for (const raw of raw_groups) {
        const id = String(raw.groupCode);
        if (!valid_group_id(id)) continue;
        const role = Number(raw.memberRole);
        const owner_uid = String(raw.ownerUid ?? raw.groupOwnerId?.memberUid ?? "");
        const owner = role === 4 || Boolean(account_uid && owner_uid === account_uid);
        const role_known = owner || role === 2 || role === 3 || Boolean(account_uid && owner_uid);
        groups.set(id, {
            id,
            name: raw.groupName || raw.remarkName || id,
            remark: raw.remarkName || "",
            members: Number(raw.memberCount ?? raw.memberNum) || 0,
            role: owner ? "owner" : role === 3 ? "admin" : role_known ? "member" : "unknown",
            retained: retained.has(id),
            owner,
            role_known
        });
    }
    return [...groups.values()];
}

function blocked_reason(group) {
    if (!group) return "该群已不在当前群列表中";
    if (group.owner) return "你是群主，请先在 QQ 中转让群主身份";
    if (!group.role_known) return "暂时无法确认你的群身份，请刷新群列表";
    if (group.retained) return "已标记为保留，请先取消保留";
    return "";
}

module.exports = { valid_group_id, extract_group_list, normalize_groups, blocked_reason };
