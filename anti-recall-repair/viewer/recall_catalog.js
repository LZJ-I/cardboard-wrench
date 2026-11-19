"use strict";

const { createHash } = require("node:crypto");

// 本模块拥有查看器的撤回消息索引，只接收已确认撤回的记录。
function text_value(value, max = 20000) {
    return value === null || value === undefined ? "" : String(value).slice(0, max);
}

function timestamp(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return 0;
    const milliseconds = number < 1e12 ? number * 1000 : number;
    return milliseconds <= 8640000000000000 ? milliseconds : 0;
}

function record_key(record) {
    const msg = record?.msg || record;
    if (!msg?.msgId) return "";
    return createHash("sha256").update(JSON.stringify([
        text_value(record.account_uid || msg.selfUid), Number(msg.chatType) || 0,
        text_value(msg.peerUid || record.sender), text_value(msg.msgId)
    ])).digest("hex");
}

function normalize_record(record, register_asset = () => "") {
    const msg = record?.msg || record;
    const id = record_key(record);
    if (!id || !Array.isArray(msg?.elements)) return null;
    const chat_type = Number(msg.chatType) || 0;
    const peer_uid = text_value(msg.peerUid || record.sender);
    const peer_number = text_value(msg.peerUin || peer_uid);
    const account_uid = text_value(record.account_uid || msg.selfUid);
    // 旧版没有账号字段，同一个 QQ 会话的新旧记录仍集中展示。
    const conversation_id = JSON.stringify([chat_type, peer_uid]);
    const sender_name = text_value(msg.sendRemarkName || msg.sendMemberName || msg.sendNickName || msg.senderUin || msg.senderUid || "未知发送者", 256);
    const title = text_value(msg.peerName || msg.groupName || msg.chatName ||
        (chat_type === 2 ? `群聊 ${peer_number}` : `私聊 ${peer_number}`), 256);
    const parts = [];
    for (const [index, element] of msg.elements.slice(0, 100).entries()) {
        if (element.textElement) parts.push({ type: "text", text: text_value(element.textElement.content) });
        else if (element.picElement) parts.push({ type: "image", asset_id: register_asset(id, index, msg, element), text: "[图片]" });
        else if (element.fileElement) parts.push({ type: "attachment", text: `[文件] ${text_value(element.fileElement.fileName, 1024)}` });
        else if (element.pttElement) parts.push({ type: "attachment", text: `[语音] ${Number(element.pttElement.duration) || 0} 秒` });
        else if (element.videoElement) parts.push({ type: "attachment", text: "[视频] " + text_value(element.videoElement.fileName, 1024) });
        else if (element.faceElement) parts.push({ type: "text", text: `[表情 ${text_value(element.faceElement.faceIndex, 20)}]` });
        else if (element.marketFaceElement) parts.push({ type: "text", text: text_value(element.marketFaceElement.faceName || "[表情包]", 256) });
        else if (element.replyElement) parts.push({ type: "attachment", text: "[回复消息]" });
        else if (element.multiForwardMsgElement || element.structLongMsgElement) parts.push({ type: "attachment", text: "[转发消息]" });
        else if (element.arkElement || element.structMsgElement) parts.push({ type: "attachment", text: "[卡片消息]" });
    }
    if (!parts.length) parts.push({ type: "attachment", text: "[此消息类型暂不支持预览，可双击定位查看]" });
    const sent_at = timestamp(msg.msgTime || msg.timeStamp);
    return {
        id, conversation_id, account_uid, chat_type, peer_uid, peer_number, title, sender_name,
        sender_number: text_value(msg.senderUin || msg.senderUid), msg_id: text_value(msg.msgId),
        sent_at, recalled_at: timestamp(record.recalled_at || msg.recallTime), parts,
        preview: parts.map(part => part.text).join(" ").slice(0, 160),
        searchable: [title, peer_number, sender_name, msg.senderUin, msg.msgId, ...parts.map(part => part.text)].join(" ").toLocaleLowerCase()
    };
}

class recall_catalog {
    constructor({ register_asset } = {}) {
        this.records = new Map();
        this.known = new Map();
        this.register_asset = register_asset;
    }

    remember(record) {
        const item = normalize_record(record, this.register_asset);
        if (!item) return null;
        const legacy_id = record_key({ msg: { msgId: item.msg_id, chatType: item.chat_type, peerUid: item.peer_uid } });
        if (!item.account_uid && this.known.has(legacy_id)) return this.records.get(this.known.get(legacy_id));
        if (item.account_uid) {
            this.records.delete(legacy_id);
            this.known.set(legacy_id, item.id);
        }
        this.records.set(item.id, item);
        return item;
    }

    list(query = "") {
        const search = text_value(query, 200).trim().toLocaleLowerCase();
        const conversations = new Map();
        for (const record of this.records.values()) {
            if (search && !record.searchable.includes(search)) continue;
            let conversation = conversations.get(record.conversation_id);
            if (!conversation) {
                conversation = { id: record.conversation_id, title: record.title, peer_number: record.peer_number,
                    chat_type: record.chat_type, count: 0, latest_at: 0, preview: "" };
                conversations.set(conversation.id, conversation);
            }
            conversation.count++;
            if (record.sent_at >= conversation.latest_at) {
                conversation.latest_at = record.sent_at;
                conversation.preview = record.preview;
                conversation.title = record.title;
            }
        }
        return {
            total: this.records.size,
            matched: [...conversations.values()].reduce((count, item) => count + item.count, 0),
            conversations: [...conversations.values()].sort((a, b) => b.latest_at - a.latest_at || a.title.localeCompare(b.title, "zh-CN"))
        };
    }

    messages({ conversation_id, query = "", offset = 0, limit = 50 } = {}) {
        if (typeof conversation_id !== "string" || conversation_id.length > 4096) throw new Error("无效会话");
        const search = text_value(query, 200).trim().toLocaleLowerCase();
        const start = Math.max(0, Math.min(1000000, Math.floor(Number(offset) || 0)));
        const size = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
        const rows = [...this.records.values()].filter(record => record.conversation_id === conversation_id &&
            (!search || record.searchable.includes(search)))
            .sort((a, b) => b.sent_at - a.sent_at || b.msg_id.localeCompare(a.msg_id));
        return { total: rows.length, next_offset: start + size < rows.length ? start + size : null,
            records: rows.slice(start, start + size).reverse().map(({ searchable, ...record }) => record) };
    }

    target(id) {
        const item = this.records.get(text_value(id, 128));
        if (!item) throw new Error("记录已不存在，请刷新后重试");
        if (!item.peer_uid || !item.chat_type) throw new Error("这条旧记录缺少会话信息，无法定位");
        return { msg_id: item.msg_id, peer_uid: item.peer_uid, chat_type: item.chat_type, account_uid: item.account_uid };
    }

    clear() { this.records.clear(); this.known.clear(); }
}

module.exports = { recall_catalog, normalize_record, record_key, timestamp };
