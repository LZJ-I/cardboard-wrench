"use strict";

const fs = require("node:fs");
const path = require("node:path");

// 本模块按登录账号保存规则和已处理消息键；不保存聊天内容。
class preferences {
    constructor(root) { this.root = root; }
    file(account, name) {
        if (typeof account !== "string" || !/^[\w-]{3,100}$/.test(account)) throw new Error("QQ 登录账号尚未就绪");
        return path.join(this.root, account, name + ".json");
    }
    read(account, name, fallback) {
        const file = this.file(account, name);
        if (!fs.existsSync(file)) return fallback;
        try { return JSON.parse(fs.readFileSync(file, "utf8")); }
        catch { throw new Error("本地配置读取失败，已停止自动回应；原文件已保留"); }
    }
    write(account, name, value) {
        const file = this.file(account, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temporary = file + ".tmp";
        fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
        fs.renameSync(temporary, file);
    }
    config(account) { return this.read(account, "rules", { enabled: false, rules: [] }); }
    processed(account) {
        const keys = this.read(account, "processed", []);
        if (!Array.isArray(keys) || keys.some(key => typeof key !== "string")) throw new Error("已处理消息记录损坏，已停止自动回应");
        return keys.slice(-5000);
    }
}

module.exports = { preferences };
