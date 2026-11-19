"use strict";

const { randomUUID } = require("node:crypto");

// 本模块拥有原生图片下载等待项，通知只读观察，不阻断 QQ 的消息流。
class native_image {
    constructor({ timeout_ms = 15000 } = {}) {
        this.timeout_ms = timeout_ms;
        this.pending = new Map();
    }

    download(contents, msg, element, destination) {
        if (!contents || contents.isDestroyed() || !msg.msgId || !msg.peerUid || !msg.chatType || !element.elementId) {
            return Promise.reject(new Error("QQ 原生图片下载上下文不完整"));
        }
        const callback_id = randomUUID();
        return new Promise((resolve, reject) => {
            const finish = (error, result) => {
                if (!this.pending.delete(callback_id)) return;
                clearTimeout(timer);
                contents.removeListener("destroyed", destroyed);
                error ? reject(error) : resolve(result);
            };
            const destroyed = () => finish(new Error("QQ 窗口已关闭"));
            const timer = setTimeout(() => finish(new Error("QQ 原生图片下载超时")), this.timeout_ms);
            this.pending.set(callback_id, { contents_id: contents.id, msg_id: String(msg.msgId), element_id: String(element.elementId), finish });
            contents.once("destroyed", destroyed);
            try {
                contents.send("LiteLoader.anti_recall.native_image_request", {
                    type: "request", eventName: "ntApi", peerId: contents.id, callbackId: callback_id
                }, {
                    cmdName: "nodeIKernelMsgService/downloadRichMedia", cmdType: "invoke",
                    payload: [{ getReq: {
                        msgId: String(msg.msgId), chatType: Number(msg.chatType), peerUid: String(msg.peerUid),
                        elementId: String(element.elementId), filePath: destination, fileModelId: "0",
                        downSourceType: 0, downloadSourceType: 0, triggerType: 1, thumbSize: 0, downloadType: 1
                    } }, null]
                });
            } catch (error) { finish(error); }
        });
    }

    observe(contents, args) {
        if (!this.pending.size) return;
        const callback_id = args[0]?.callbackId;
        const request = this.pending.get(callback_id);
        if (request?.contents_id === contents.id) {
            const result = args[1];
            if (result?.promiseStatus === "fail" || result?.promiseStatue === "fail" ||
                (typeof result?.result === "number" && result.result !== 0) ||
                (typeof result?.errCode === "number" && result.errCode !== 0)) {
                request.finish(new Error("QQ 拒绝了图片下载请求"));
            }
        }
        const walk = (value, depth = 0) => {
            if (!value || typeof value !== "object" || depth > 7) return;
            if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return; }
            if (String(value.cmdName || "").endsWith("/onRichMediaDownloadComplete")) {
                this.complete(contents.id, value.payload);
                return;
            }
            for (const key of ["payload", "data", "result"]) walk(value[key], depth + 1);
        };
        walk(args);
    }

    complete(contents_id, payload) {
        const walk = (value, depth = 0) => {
            if (!value || typeof value !== "object" || depth > 7) return;
            if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return; }
            const msg_id = String(value.msgId || "");
            const element_id = String(value.msgElementId || value.elementId || "");
            for (const item of [...this.pending.values()]) {
                if (item.contents_id !== contents_id || item.msg_id !== msg_id || item.element_id !== element_id) continue;
                const file_path = value.filePath || value.commonFileInfo?.filePath;
                if (Number(value.fileErrCode || 0) !== 0) item.finish(new Error("QQ 图片下载失败"));
                else if (typeof file_path === "string" && file_path) item.finish(null, file_path);
            }
            for (const child of Object.values(value)) walk(child, depth + 1);
        };
        walk(payload);
    }

    dispose() {
        for (const item of [...this.pending.values()]) item.finish(new Error("QQ 已退出"));
    }
}

module.exports = { native_image };
