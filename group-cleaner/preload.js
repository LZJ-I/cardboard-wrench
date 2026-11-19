"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// 仅暴露群清理所需操作，页面无法借此调用任意 QQ 原生接口。
const prefix = "LiteLoader.group_cleaner.";
// 经真实渲染进程 IPC 发送，使 QQ 获得原生 senderFrame 与进程上下文。
const native_commands = new Set([
    "getGroupList", "nodeIKernelGroupService/getGroupList",
    "nodeIKernelGroupService/quitGroup", "nodeIKernelGroupService/quitGroupV2", "quitGroup", "quitGroupV2"
]);
ipcRenderer.on(prefix + "native_request", (_event, header, command) => {
    if (header?.type !== "request" || !Number.isInteger(header.peerId) || header.peerId <= 0 ||
        typeof header.callbackId !== "string" || !native_commands.has(command?.cmdName) ||
        !["invoke", "ntApi"].includes(command.cmdType) || !Array.isArray(command.payload) ||
        !/^(?:ntApi|NodeStoreApi|ns-ntApi-\d+|ns-NodeStoreApi-\d+)$/.test(header.eventName)) return;
    ipcRenderer.send(`RM_IPCFROM_RENDERER${header.peerId}`, header, command);
});
contextBridge.exposeInMainWorld("group_cleaner", {
    state: () => ipcRenderer.invoke(prefix + "state"),
    refresh: () => ipcRenderer.invoke(prefix + "refresh"),
    retain: (id, retained) => ipcRenderer.invoke(prefix + "retain", id, retained),
    open_group: id => ipcRenderer.invoke(prefix + "open_group", id),
    calibrate: () => ipcRenderer.invoke(prefix + "calibrate"),
    cancel_calibration: () => ipcRenderer.invoke(prefix + "cancel_calibration"),
    prepare: ids => ipcRenderer.invoke(prefix + "prepare", ids),
    start: token => ipcRenderer.invoke(prefix + "start", token),
    stop: () => ipcRenderer.invoke(prefix + "stop"),
    on_progress: callback => {
        const listener = (_event, job) => callback(job);
        ipcRenderer.on(prefix + "progress", listener);
        return () => ipcRenderer.removeListener(prefix + "progress", listener);
    },
    on_calibration: callback => {
        const listener = (_event, state) => callback(state);
        ipcRenderer.on(prefix + "calibration", listener);
        return () => ipcRenderer.removeListener(prefix + "calibration", listener);
    },
    on_account_changed: callback => {
        const listener = () => callback();
        ipcRenderer.on(prefix + "account_changed", listener);
        return () => ipcRenderer.removeListener(prefix + "account_changed", listener);
    }
});
