"use strict";

const fs = require("node:fs");
const path = require("node:path");

// 本模块只读取 QQ 自带的可见表情目录，不修改表情资源或访问网络。
function load_catalog({ resources, documents }) {
    const entries = new Map();
    const add = (id, type, label, file) => {
        id = String(id ?? "");
        if (!/^\d{1,16}$/.test(id) || entries.has(id)) return;
        let src = "";
        try {
            if (fs.statSync(file).size <= 100000) src = "data:image/png;base64," + fs.readFileSync(file).toString("base64");
        } catch {}
        if (src) entries.set(id, { id, type, label: String(label || id).replace(/^\/+/, ""), src });
    };
    const resource_roots = Array.isArray(resources) ? resources : [resources];
    for (const directory of resource_roots.filter(Boolean).flatMap(root => [path.join(root, "app/resource/default-emojis"), path.join(root, "app.asar.unpacked/resource/default-emojis")])) {
        try {
            const config = JSON.parse(fs.readFileSync(path.join(directory, "default_config.json"), "utf8"));
            for (const group of config.normalPanelResult?.SysEmojiGroupList || []) {
                for (const item of group.SysEmojiList || []) {
                    if (item.isHide || Number(item.emojiType) === 4) continue;
                    add(item.emojiId, "1", item.describe, path.join(directory, String(item.emojiId) + ".png"));
                }
            }
        } catch {}
    }
    const directory = path.join(documents, "Tencent Files/nt_qq/global/nt_data/Emoji/emoji-resource");
    try {
        const config = JSON.parse(fs.readFileSync(path.join(directory, "face_config.json"), "utf8"));
        for (const item of config.emoji || []) {
            if (String(item.QHide || "0") === "1" || !/^\d+$/.test(String(item.AQLid))) continue;
            add(item.QCid, "2", item.QDes || item.QSid, path.join(directory, "emoji_res", `emoji_${String(item.AQLid).padStart(3, "0")}.png`));
        }
    } catch {}
    return [...entries.values()];
}

module.exports = { load_catalog };
