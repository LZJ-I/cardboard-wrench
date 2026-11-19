"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { read_image, verify_image } = require("./image_file");
const { image_urls, fetch_image } = require("./image_http");

// 本模块拥有图片预取队列与插件媒体缓存；未撤回图片两小时后或超额时淘汰。
class image_cache {
    constructor({ root, native, persist = () => true, log = () => {}, fetch = fetch_image,
        concurrency = 3, max_bytes = 32 * 1024 * 1024, staging_bytes = 512 * 1024 * 1024,
        ttl_ms = 2 * 60 * 60 * 1000, now = Date.now } = {}) {
        Object.assign(this, { root, native, persist, log, fetch, concurrency, max_bytes, staging_bytes, ttl_ms, now });
        this.jobs = new Map();
        this.queue = [];
        this.active = 0;
        this.recalled = new Set();
        this.failures = new Map();
        this.closed = false;
        this.maintenance = Promise.resolve();
        this.ready = Promise.all(["staging", "recalled"].map(dir => fs.mkdir(path.join(root, dir), { recursive: true })))
            .then(() => this.prune());
        void this.ready.catch(error => this.log("图片缓存初始化失败：" + error.message));
    }

    key(msg, element) {
        if (/^[a-f0-9]{64}$/.test(element.anti_recall_image_key || "")) return element.anti_recall_image_key;
        // QQ 账号目录属于键的一部分，避免多账号复用同一条消息的缓存。
        return createHash("sha256").update(JSON.stringify([
            msg.selfUid || "", msg.peerUid, String(msg.msgId), String(element.elementId || ""),
            element.picElement?.sourcePath || "", element.picElement?.md5HexStr || ""
        ])).digest("hex");
    }

    prefetch(msg, contents) {
        if (this.closed || !Array.isArray(msg?.elements) || Number(msg.msgType) === 5) return;
        for (const element of msg.elements) {
            if (element?.picElement) void this.enqueue(msg, element, contents).catch(() => {});
        }
    }

    enqueue(msg, element, contents, recalled = false) {
        if (this.closed) return Promise.resolve(null);
        const key = this.key(msg, element);
        if (recalled) this.recalled.add(key);
        const existing = this.jobs.get(key);
        if (existing) {
            if (recalled) {
                const index = this.queue.indexOf(existing);
                if (index > 0) { this.queue.splice(index, 1); this.queue.unshift(existing); }
            }
            return existing.promise;
        }
        if (this.queue.length >= 128 && !recalled) return Promise.resolve(null);
        // 同一条失效图片的重复窗口通知不反复打服务器；撤回允许立即补救一次。
        if (!recalled && this.failures.has(key) && this.now() - this.failures.get(key) < 30000) return Promise.resolve(null);
        const job = { key, msg, element, contents };
        job.promise = new Promise(resolve => { job.resolve = resolve; });
        this.jobs.set(key, job);
        recalled ? this.queue.unshift(job) : this.queue.push(job);
        this.drain();
        return job.promise;
    }

    drain() {
        while (!this.closed && this.active < this.concurrency && this.queue.length) {
            const job = this.queue.shift();
            this.active++;
            void this.run(job).catch(error => {
                this.failures.set(job.key, this.now());
                while (this.failures.size > 2048) this.failures.delete(this.failures.keys().next().value);
                this.log("图片缓存未完成：" + error.message);
                return null;
            }).then(result => {
                this.jobs.delete(job.key);
                this.active--;
                job.resolve(result);
                this.drain();
            });
        }
    }

    async run(job) {
        await this.ready;
        const pic = job.element.picElement;
        if (Number(pic.fileSize || 0) > this.max_bytes) throw new Error("图片超过 32 MiB 后台缓存限制");
        const staging_path = path.join(this.root, "staging", job.key + ".image");
        const recalled_path = path.join(this.root, "recalled", job.key + ".image");
        let data = await read_image(recalled_path, pic.md5HexStr, this.max_bytes);
        if (data) return recalled_path;
        data = await read_image(staging_path, pic.md5HexStr, this.max_bytes);
        if (!data) data = await read_image(pic.sourcePath, pic.md5HexStr, this.max_bytes);
        if (!data) {
            // 原生接口使用 QQ 的登录凭证；先在撤回前完成下载，HTTP 只作有凭证链接的后备。
            try {
                const destination = typeof pic.sourcePath === "string" && path.isAbsolute(pic.sourcePath)
                    ? pic.sourcePath : staging_path + ".native";
                const downloaded = await this.native.download(job.contents, job.msg, job.element, destination);
                data = await read_image(downloaded, pic.md5HexStr, this.max_bytes);
                if (destination.endsWith(".native")) await fs.unlink(destination).catch(() => {});
            } catch {}
            if (this.closed) throw new Error("QQ 已退出，已停止图片缓存");
            if (!data) {
                for (const url of image_urls(pic)) {
                    try {
                        data = verify_image(await this.fetch(url, { max_bytes: this.max_bytes }), pic.md5HexStr);
                        break;
                    } catch { data = null; }
                }
            }
        }
        if (!data) throw new Error("原生下载及图片链接均不可用");
        const destination = this.recalled.has(job.key) && this.persist() ? recalled_path : staging_path;
        await this.write_atomic(destination, data);
        this.failures.delete(job.key);
        this.maintenance = this.maintenance.then(() => this.prune()).catch(error => this.log(error.message));
        return destination;
    }

    async restore(msg, contents) {
        if (!Array.isArray(msg?.elements)) return false;
        let restored = false;
        for (const element of msg.elements) {
            if (!element?.picElement) continue;
            const key = this.key(msg, element);
            const cached = await this.enqueue(msg, element, contents, true);
            if (!cached) continue;
            const data = await read_image(cached, element.picElement.md5HexStr, this.max_bytes);
            if (!data) continue;
            if (this.persist()) {
                await this.write_atomic(path.join(this.root, "recalled", key + ".image"), data);
            }
            const pic = element.picElement;
            const source = typeof pic.sourcePath === "string" && path.isAbsolute(pic.sourcePath) ? pic.sourcePath : cached;
            // QQ 仍按原消息中的路径访问媒体；补齐路径后再交给渲染层，避免先失败再等待轮询。
            const old_thumbs = pic.thumbPath && typeof pic.thumbPath.values === "function"
                ? [...pic.thumbPath.values()] : Object.values(pic.thumbPath || {});
            for (const target of new Set([source, ...old_thumbs])) {
                if (typeof target === "string" && path.isAbsolute(target)) {
                    await this.write_atomic(target, data).catch(error => this.log("补齐图片缓存路径失败：" + error.message));
                }
            }
            if (!await read_image(source, pic.md5HexStr, this.max_bytes)) continue;
            pic.sourcePath = source;
            pic.thumbPath = new Map([[0, source], [198, source], [720, source]]);
            element.anti_recall_image_key = key;
            restored = true;
        }
        return restored;
    }

    async write_atomic(destination, data) {
        await fs.mkdir(path.dirname(destination), { recursive: true });
        const temporary = destination + "." + randomUUID() + ".part";
        try {
            await fs.writeFile(temporary, data, { flag: "wx" });
            await fs.rename(temporary, destination);
        } finally { await fs.unlink(temporary).catch(() => {}); }
    }

    async prune() {
        const directory = path.join(this.root, "staging");
        const entries = [];
        for (const name of await fs.readdir(directory)) {
            // 只清理本模块命名的文件，不删除 QQ 或其它插件的数据。
            if (!/^[a-f0-9]{64}\.image$/.test(name)) continue;
            try {
                const file_path = path.join(directory, name);
                const stat = await fs.stat(file_path);
                entries.push({ file_path, size: stat.size, time: stat.mtimeMs, key: name.slice(0, 64) });
            } catch {}
        }
        entries.sort((a, b) => a.time - b.time);
        let total = entries.reduce((sum, entry) => sum + entry.size, 0);
        for (const entry of entries) {
            if (this.jobs.has(entry.key)) continue;
            if (total <= this.staging_bytes && this.now() - entry.time < this.ttl_ms) continue;
            await fs.unlink(entry.file_path).catch(() => {});
            total -= entry.size;
        }
    }

    async clear_saved() {
        await this.ready;
        const directory = path.join(this.root, "recalled");
        for (const name of await fs.readdir(directory)) {
            if (/^[a-f0-9]{64}\.image$/.test(name)) await fs.unlink(path.join(directory, name));
        }
        this.recalled.clear();
    }

    dispose() {
        this.closed = true;
        for (const job of this.queue.splice(0)) { this.jobs.delete(job.key); job.resolve(null); }
        this.native.dispose();
    }
}

module.exports = { image_cache };
