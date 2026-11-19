"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// 只暴露记录查询、已登记图片读取和已保存消息定位。
const prefix = "LiteLoader.anti_recall.viewer.";
contextBridge.exposeInMainWorld("recall_history", {
    list: options => ipcRenderer.invoke(prefix + "list", options),
    messages: options => ipcRenderer.invoke(prefix + "messages", options),
    media: options => ipcRenderer.invoke(prefix + "media", options),
    jump: id => ipcRenderer.invoke(prefix + "jump", { id }),
    changed: callback => {
        const listener = () => callback();
        ipcRenderer.on(prefix + "changed", listener);
        return () => ipcRenderer.removeListener(prefix + "changed", listener);
    }
});
