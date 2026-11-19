"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { recall_catalog } = require("./recall_catalog");
const { recall_media } = require("./recall_media");
const { jump_message } = require("./recall_jump");

// 本模块拥有独立查看窗口、IPC 权限和历史加载任务。
class recall_viewer {
    constructor({ electron, read_records, candidates, saved, account = () => "" }) {
        Object.assign(this, { electron, read_records, saved, account });
        this.window = null;
        this.loaded = false;
        this.loading = null;
        this.error = "";
        this.file = path.join(__dirname, "viewer.html");
        this.media = new recall_media({ candidates, native_image: electron.nativeImage });
        this.catalog = new recall_catalog({ register_asset: (...args) => this.media.register(...args) });
        const bind = (name, handler) => electron.ipcMain.handle("LiteLoader.anti_recall.viewer." + name, async (event, options) => {
            try {
                this.assert_viewer(event);
                return { ok: true, data: await handler(options || {}) };
            } catch (error) { return { ok: false, error: error.message || String(error) }; }
        });
        bind("list", async options => {
            await this.load(Boolean(options.refresh));
            return { ...this.catalog.list(options.query), saved: Boolean(this.saved()), warning: this.error };
        });
        bind("messages", async options => { await this.load(); return this.catalog.messages(options); });
        bind("media", options => this.media.read(options.asset_id, options.full === true));
        bind("jump", async options => {
            await this.load();
            return jump_message(this.catalog.target(options.id), {
                windows: electron.BrowserWindow.getAllWindows(), account_uid: this.account()
            });
        });
        electron.ipcMain.handle("LiteLoader.anti_recall.open_viewer", async event => {
            const url = event.sender.getURL();
            if (!url.startsWith("app://") || !/#\/(?:setting|main|chat)(?:\/|$)/.test(url) ||
                (event.senderFrame && event.sender.mainFrame && event.senderFrame !== event.sender.mainFrame)) {
                throw new Error("请从 QQ 的防撤回设置中打开查看窗口");
            }
            this.open();
            return true;
        });
    }

    assert_viewer(event) {
        if (!this.window || this.window.isDestroyed() || event.sender !== this.window.webContents ||
            event.sender.getURL().split("#")[0] !== pathToFileURL(this.file).href ||
            (event.senderFrame && event.sender.mainFrame && event.senderFrame !== event.sender.mainFrame)) {
            throw new Error("此接口仅供撤回消息查看窗口使用");
        }
    }

    async load(refresh = false) {
        if (this.loading) return this.loading;
        if (this.loaded && !refresh) return;
        this.loading = (async () => {
            try {
                const records = await this.read_records();
                for (const record of records) this.catalog.remember(record);
                this.loaded = true;
                this.error = "";
            } catch (error) {
                this.error = "历史记录读取失败：" + error.message;
                // 读取失败保留实时记录，避免把错误显示成“没有撤回数据”。
            }
        })().finally(() => { this.loading = null; });
        return this.loading;
    }

    remember(record) {
        if (this.catalog.remember(record)) this.publish();
    }

    publish() {
        if (this.window && !this.window.isDestroyed()) {
            this.window.webContents.send("LiteLoader.anti_recall.viewer.changed");
        }
    }

    clear() {
        this.catalog.clear();
        this.media.clear();
        this.loaded = false;
        this.publish();
    }

    open() {
        if (this.window && !this.window.isDestroyed()) {
            if (this.window.isMinimized()) this.window.restore();
            this.window.show(); this.window.focus(); this.publish();
            return;
        }
        const window = new this.electron.BrowserWindow({
            title: "撤回消息查看", width: 1040, height: 760, minWidth: 760, minHeight: 500,
            backgroundColor: "#14161b", autoHideMenuBar: true, show: false,
            webPreferences: { preload: path.join(__dirname, "viewer_preload.js"),
                nodeIntegration: false, contextIsolation: true, sandbox: true }
        });
        this.window = window;
        window.setMenu(null);
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        window.webContents.on("will-navigate", event => event.preventDefault());
        window.once("ready-to-show", () => { window.show(); window.focus(); });
        window.once("closed", () => { if (this.window === window) this.window = null; });
        window.loadFile(this.file).catch(error => {
            this.error = "查看窗口加载失败：" + error.message;
            this.electron.dialog.showErrorBox("撤回消息查看", this.error);
        });
    }
}

module.exports = { recall_viewer };
