"use strict";

const { randomUUID } = require("node:crypto");

// 本模块拥有等待中的 QQ IPC 请求；只观察回包，不阻断或替换 QQ 消息。
class NativeTransport {
    constructor({ ipc_main, web_contents, interceptor, timeout_ms = 12000, dispatch }) {
        this.ipc_main = ipc_main;
        this.web_contents = web_contents;
        this.timeout_ms = timeout_ms;
        this.dispatch = dispatch;
        this.pending = new Map();
        this.observers = new Set();
        this.unsubscribe = interceptor.onIpcSend((channel, header, body) => {
            const request = this.pending.get(header?.callbackId);
            if (request && channel === `RM_IPCFROM_MAIN${request.peer_id}`) {
                request.finish(null, body);
            }
            for (const observer of this.observers) {
                try { observer(channel, header, body); }
                catch (error) { console.warn("[群清理助手] 读取 QQ 通知失败", error.message); }
            }
        });
    }

    observe(callback) {
        this.observers.add(callback);
        return () => this.observers.delete(callback);
    }

    find_peer() {
        const peers = this.web_contents.getAllWebContents().filter(contents => {
            if (contents.isDestroyed()) return false;
            return /#\/main(?:\/|$)/.test(contents.getURL()) &&
                this.ipc_main.listenerCount(`RM_IPCFROM_RENDERER${contents.id}`) > 0;
        });
        if (!peers.length) throw new Error("未找到已登录的 QQ 主窗口，请先完成登录并打开消息页");
        return peers[0];
    }

    request(event_name, command_name, payload, cmd_type = "invoke") {
        if (!["invoke", "ntApi"].includes(cmd_type)) throw new Error("不支持的 QQ 请求类型");
        const peer = this.find_peer();
        const callback_id = randomUUID();
        const channel = `RM_IPCFROM_RENDERER${peer.id}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => finish(new Error(`QQ 接口超时：${command_name}；不会自动重复发送`)), this.timeout_ms);
            const finish = (error, result) => {
                if (!this.pending.delete(callback_id)) return;
                clearTimeout(timer);
                peer.removeListener("destroyed", on_destroyed);
                error ? reject(error) : resolve(result);
            };
            const on_destroyed = () => finish(new Error("QQ 主窗口已关闭"));
            this.pending.set(callback_id, { peer_id: peer.id, finish });
            peer.once("destroyed", on_destroyed);
            try {
                const header = {
                    type: "request", eventName: event_name,
                    peerId: peer.id, callbackId: callback_id
                };
                const command = { cmdName: command_name, cmdType: cmd_type, payload };
                if (this.dispatch) {
                    this.dispatch(peer, header, command);
                    return;
                }
                this.ipc_main.emit(channel, {
                    sender: peer,
                    reply: (reply_channel, ...args) => {
                        if (!peer.isDestroyed()) peer.send(reply_channel, ...args);
                    }
                }, header, command);
            } catch (error) { finish(error); }
        });
    }

    dispose() {
        this.unsubscribe?.();
        for (const request of [...this.pending.values()]) request.finish(new Error("QQ 会话已结束"));
        this.observers.clear();
    }
}

module.exports = { NativeTransport };
