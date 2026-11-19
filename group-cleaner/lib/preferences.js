"use strict";

const fs = require("node:fs");
const path = require("node:path");

// 按账号持有保留名单，原子落盘；群列表和退群计划不持久化。
class Preferences {
    constructor(data_path) { this.data_path = data_path; }

    file_for(account_uid) {
        if (!/^[\w-]{3,100}$/.test(account_uid)) throw new Error("QQ 登录账号尚未就绪");
        return path.join(this.data_path, `${account_uid}.json`);
    }

    read(account_uid) {
        const file = this.file_for(account_uid);
        if (!fs.existsSync(file)) return { retained: [] };
        try {
            const config = JSON.parse(fs.readFileSync(file, "utf8"));
            if (!Array.isArray(config.retained)) throw new Error("保留名单格式异常");
            return { retained: config.retained.filter(id => typeof id === "string") };
        } catch {
            throw new Error("保留名单读取失败，已暂停操作；请检查插件数据目录，原文件已保留");
        }
    }

    set_retained(account_uid, group_id, retained) {
        const config = this.read(account_uid);
        const ids = new Set(config.retained);
        retained ? ids.add(group_id) : ids.delete(group_id);
        fs.mkdirSync(this.data_path, { recursive: true });
        const file = this.file_for(account_uid);
        const temporary = file + ".tmp";
        fs.writeFileSync(temporary, JSON.stringify({ retained: [...ids] }, null, 2), "utf8");
        fs.renameSync(temporary, file);
    }
}

module.exports = { Preferences };
