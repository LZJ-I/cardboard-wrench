"use strict";

const fs = require("node:fs/promises");
const { createHash } = require("node:crypto");

// 本模块负责图片文件完整性判断，不保存消息或下载状态。
function is_image(data) {
    if (!Buffer.isBuffer(data) || data.length < 12) return false;
    return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        data.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
        /^GIF8[79]a/.test(data.toString("ascii", 0, 6)) ||
        (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") ||
        data.toString("ascii", 0, 2) === "BM" ||
        (data.toString("ascii", 4, 8) === "ftyp" && /^(avif|avis|heic|heix|mif1)$/.test(data.toString("ascii", 8, 12)));
}

function verify_image(data, md5 = "") {
    if (!is_image(data)) throw new Error("下载结果不是有效图片");
    if (/^[a-f0-9]{32}$/i.test(md5) && createHash("md5").update(data).digest("hex") !== md5.toLowerCase()) {
        throw new Error("图片校验和不匹配，未写入 QQ 缓存");
    }
    return data;
}

async function read_image(file_path, md5 = "", max_bytes = 32 * 1024 * 1024) {
    if (typeof file_path !== "string" || !file_path) return null;
    try {
        const stat = await fs.stat(file_path);
        if (!stat.isFile() || stat.size < 12 || stat.size > max_bytes) return null;
        return verify_image(await fs.readFile(file_path), md5);
    } catch { return null; }
}

module.exports = { is_image, verify_image, read_image };
