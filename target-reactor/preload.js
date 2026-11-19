"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// 页面仅能保存规则；回应请求只接收主进程发出的固定接口与完整消息身份。
const prefix = "LiteLoader.target_reactor.";
ipcRenderer.on(prefix + "native_request", (_event, header, command) => {
    const request = command?.payload?.[0];
    if (header?.type !== "request" || header.eventName !== "ntApi" || !Number.isInteger(header.peerId) || header.peerId <= 0 ||
        typeof header.callbackId !== "string" || command?.cmdName !== "nodeIKernelMsgService/setMsgEmojiLikes" || command.cmdType !== "invoke" ||
        !Array.isArray(command.payload) || request?.peer?.chatType !== 2 || !/^[1-9]\d{3,19}$/.test(request.peer.peerUid) ||
        !/^\d+$/.test(request.msgSeq) || !/^\d{1,16}$/.test(request.emojiId) || !["1", "2"].includes(request.emojiType) || request.setEmoji !== true) return;
    ipcRenderer.send(`RM_IPCFROM_RENDERER${header.peerId}`, header, command);
});
contextBridge.exposeInMainWorld("target_reactor", {
    state: include_catalog => ipcRenderer.invoke(prefix + "state", include_catalog === true),
    save: config => ipcRenderer.invoke(prefix + "save", config),
    changed: callback => {
        const listener = () => callback();
        ipcRenderer.on(prefix + "changed", listener);
        return () => ipcRenderer.removeListener(prefix + "changed", listener);
    }
});
