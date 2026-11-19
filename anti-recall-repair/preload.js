const { contextBridge, ipcRenderer } = require("electron");

// 仅允许主进程请求图片下载，不向网页暴露通用 QQ 接口。
ipcRenderer.on("LiteLoader.anti_recall.native_image_request", (_event, header, command) => {
    if (header?.type !== "request" || header.eventName !== "ntApi" ||
        !Number.isInteger(header.peerId) || header.peerId <= 0 || typeof header.callbackId !== "string" ||
        command?.cmdName !== "nodeIKernelMsgService/downloadRichMedia" || command.cmdType !== "invoke" ||
        !Array.isArray(command.payload) || !command.payload[0]?.getReq) return;
    ipcRenderer.send(`RM_IPCFROM_RENDERER${header.peerId}`, header, command);
});

contextBridge.exposeInMainWorld("anti_recall", {
    open_viewer: () => ipcRenderer.invoke("LiteLoader.anti_recall.open_viewer"),
    clearDb: () => ipcRenderer.invoke("LiteLoader.anti_recall.clearDb"),
    getNowConfig: () =>
        ipcRenderer.invoke("LiteLoader.anti_recall.getNowConfig"),
    saveConfig: (config) =>
        ipcRenderer.invoke("LiteLoader.anti_recall.saveConfig", config),
    repatchCss: (callback) =>
        ipcRenderer.on(
            "LiteLoader.anti_recall.mainWindow.repatchCss",
            callback
        ),
    recallTip: (callback) =>
        ipcRenderer.on("LiteLoader.anti_recall.mainWindow.recallTip", callback),
    recallTipList: (callback) =>
        ipcRenderer.on(
            "LiteLoader.anti_recall.mainWindow.recallTipList",
            callback
        )
});
