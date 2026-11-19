"use strict";

const { createHash } = require("node:crypto");
const { read_image } = require("../lib/image_file");

// 本模块拥有查看器图片令牌，页面不能传入或读取任意本地路径。
class recall_media {
    constructor({ candidates, native_image } = {}) {
        this.entries = new Map();
        this.candidates = candidates;
        this.native_image = native_image;
    }

    register(id, index, msg, element) {
        const token = createHash("sha256").update(id + ":" + index).digest("hex");
        this.entries.set(token, { msg, element });
        return token;
    }

    async read(token, full = false) {
        const entry = typeof token === "string" && this.entries.get(token);
        if (!entry) throw new Error("图片记录已不存在，请刷新");
        for (const candidate of this.candidates(entry.msg, entry.element)) {
            const data = await read_image(candidate.path, candidate.md5);
            if (!data) continue;
            if (!full && this.native_image) {
                try {
                    const image = this.native_image.createFromBuffer(data);
                    if (!image.isEmpty()) {
                        const size = image.getSize();
                        const thumbnail = Math.max(size.width, size.height) > 640
                            ? image.resize(size.width >= size.height ? { width: 640 } : { height: 640 }) : image;
                        return { url: thumbnail.toDataURL() };
                    }
                } catch {}
            }
            const mime = data[0] === 137 ? "image/png" : data[0] === 255 ? "image/jpeg"
                : data.toString("ascii", 0, 3) === "GIF" ? "image/gif"
                    : data.toString("ascii", 8, 12) === "WEBP" ? "image/webp"
                        : data.toString("ascii", 0, 2) === "BM" ? "image/bmp" : "image/avif";
            return { url: `data:${mime};base64,${data.toString("base64")}` };
        }
        throw new Error("本地图片未保存或已被清理；可双击消息到 QQ 中查看");
    }

    clear() { this.entries.clear(); }
}

module.exports = { recall_media };
