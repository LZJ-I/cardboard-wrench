"use strict";

const https = require("node:https");
const { verify_image } = require("./image_file");

// 本模块只负责有大小、时限和跳转限制的腾讯图片下载。
const image_hosts = new Set(["gchat.qpic.cn", "c2cpicdw.qpic.cn", "multimedia.nt.qq.com.cn"]);

function image_urls(pic) {
    const urls = [];
    for (const value of [pic.originImageUrl, pic.originUrl]) {
        if (typeof value !== "string" || !value) continue;
        try {
            const url = new URL(value, "https://gchat.qpic.cn");
            if (!image_hosts.has(url.hostname)) continue;
            if (["1406", "1407"].includes(url.searchParams.get("appid"))) {
                url.hostname = "multimedia.nt.qq.com.cn";
                // 新协议没有 rkey 时交给 QQ 原生下载，不把空凭证拼进地址。
                if (!url.searchParams.get("rkey")) continue;
            }
            url.protocol = "https:";
            urls.push(url.href);
        } catch {}
    }
    if (/^[a-f0-9]{32}$/i.test(pic.md5HexStr || "")) {
        urls.push(`https://gchat.qpic.cn/gchatpic_new/0/0-0-${pic.md5HexStr.toUpperCase()}/0`);
    }
    return [...new Set(urls)];
}

function fetch_image(url, { max_bytes = 32 * 1024 * 1024, timeout_ms = 12000, get = https.get } = {}) {
    return new Promise((resolve, reject) => {
        let request;
        let response;
        let settled = false;
        const finish = (error, data) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) { response?.destroy(); request?.destroy(); reject(error); }
            else resolve(data);
        };
        const timer = setTimeout(() => finish(new Error("图片下载超时")), timeout_ms);
        const visit = (address, redirects) => {
            try {
                const target = new URL(address);
                if (target.protocol !== "https:" || !image_hosts.has(target.hostname) || target.username || target.password || target.port) {
                    throw new Error("图片下载地址不受支持");
                }
                request = get(target, res => {
                    response = res;
                    res.on("error", error => finish(error));
                    if (res.statusCode >= 300 && res.statusCode < 400) {
                        res.resume();
                        if (!res.headers.location || redirects >= 3) return finish(new Error("图片跳转次数超限"));
                        try { visit(new URL(res.headers.location, target).href, redirects + 1); }
                        catch (error) { finish(error); }
                        return;
                    }
                    if (res.statusCode !== 200) return finish(new Error(`图片服务器返回 ${res.statusCode}`));
                    const expected = Number(res.headers["content-length"]);
                    if (expected > max_bytes) return finish(new Error("图片超过缓存大小限制"));
                    let size = 0;
                    const chunks = [];
                    res.on("aborted", () => finish(new Error("图片下载中断")));
                    res.on("data", chunk => {
                        size += chunk.length;
                        if (size > max_bytes) finish(new Error("图片超过缓存大小限制"));
                        else chunks.push(chunk);
                    });
                    res.on("end", () => {
                        if (settled) return;
                        if (Number.isFinite(expected) && expected > 0 && size !== expected) return finish(new Error("图片下载不完整"));
                        try { finish(null, verify_image(Buffer.concat(chunks))); }
                        catch (error) { finish(error); }
                    });
                });
                request.on("error", error => finish(error));
            } catch (error) { finish(error); }
        };
        visit(url, 0);
    });
}

module.exports = { image_urls, fetch_image };
