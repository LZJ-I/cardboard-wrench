"use strict";

const { randomUUID } = require("node:crypto");

// 本模块拥有回应请求及回包等待项；经 QQ 真实渲染进程发送，不改写 QQ 通知。
class native_transport {
    constructor({ ipc_main, web_contents, interceptor, timeout_ms = 10000 }) {
        Object.assign(this, { ipc_main, web_contents, timeout_ms });
        this.pending = new Map();
        this.observers = new Set();
        this.unsubscribe = interceptor.onIpcSend((channel, header, body) => {
            const pending = this.pending.get(header?.callbackId);
            if (pending && channel === `RM_IPCFROM_MAIN${pending.peer_id}`) pending.finish(null, body);
            for (const observer of this.observers) {
                try { observer(channel, header, body); } catch (error) { console.warn("[定点表情回应]", error.message); }
            }
        });
    }
    observe(callback) { this.observers.add(callback); return () => this.observers.delete(callback); }
    request(payload) {
        const peer = this.web_contents.getAllWebContents().find(contents => !contents.isDestroyed() &&
            contents.getURL().startsWith("app://") && /#\/main(?:\/|$)/.test(contents.getURL()) && this.ipc_main.listenerCount(`RM_IPCFROM_RENDERER${contents.id}`));
        if (!peer) return Promise.reject(new Error("QQ 主窗口未就绪"));
        const callback_id = randomUUID();
        return new Promise((resolve, reject) => {
            const finish = (error, result) => {
                if (!this.pending.delete(callback_id)) return;
                clearTimeout(timer); peer.removeListener("destroyed", destroyed);
                error ? reject(error) : resolve(result);
            };
            const destroyed = () => finish(new Error("QQ 主窗口已关闭"));
            const timer = setTimeout(() => finish(new Error("表情回应超时；未自动重试")), this.timeout_ms);
            this.pending.set(callback_id, { peer_id: peer.id, finish });
            peer.once("destroyed", destroyed);
            try {
                peer.send("LiteLoader.target_reactor.native_request", {
                    type: "request", eventName: "ntApi", peerId: peer.id, callbackId: callback_id
                }, { cmdName: "nodeIKernelMsgService/setMsgEmojiLikes", cmdType: "invoke", payload });
            } catch (error) { finish(error); }
        });
    }
    dispose() {
        this.unsubscribe?.();
        for (const pending of [...this.pending.values()]) pending.finish(new Error("QQ 会话已结束"));
        this.observers.clear();
    }
}

module.exports = { native_transport };
