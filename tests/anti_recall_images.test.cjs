"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const fs_sync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const { createHash } = require("node:crypto");
const { image_cache } = require("../anti-recall-repair/lib/image_cache");
const { native_image } = require("../anti-recall-repair/lib/native_image");
const { image_urls, fetch_image } = require("../anti-recall-repair/lib/image_http");
const { ImgDownloader } = require("../anti-recall-repair/imgDownloader");

const picture = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9sAAAAASUVORK5CYII=", "base64");
const md5 = createHash("md5").update(picture).digest("hex");
const tick = () => new Promise(resolve => setImmediate(resolve));
async function wait_until(predicate) {
    const deadline = Date.now() + 2500;
    while (!predicate()) { if (Date.now() > deadline) throw new Error("等待测试事件超时"); await tick(); }
}
function record(root, suffix = "1") {
    return { msgId: "msg" + suffix, chatType: 2, peerUid: "group", msgType: 2, elements: [{
        elementId: "image" + suffix, picElement: { md5HexStr: md5, fileSize: picture.length,
            sourcePath: path.join(root, "account" + suffix, "original.png"),
            originImageUrl: "/download?appid=1407&rkey=existing-key&fileid=test",
            thumbPath: new Map([[198, path.join(root, "account" + suffix, "thumb.png")]]) }
    }] };
}
async function setup(t, options = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "qq-recall-images-"));
    const native = options.native || { download: async () => { throw new Error("禁止真实 QQ 下载"); }, dispose() {} };
    const cache = new image_cache({ root: path.join(root, "cache"), native,
        fetch: async () => { throw new Error("禁止真实网络请求"); }, ...options });
    await cache.ready;
    t.after(async () => { cache.dispose(); await fs.rm(root, { recursive: true, force: true }); });
    return { root, cache };
}

test("后台接收立即下载；撤回与预取共用任务，恢复原图和缩略图", async t => {
    let calls = 0;
    let complete;
    const { root, cache } = await setup(t, { native: { dispose() {}, download: async (_contents, _msg, _el, destination) => {
        calls++;
        await new Promise(resolve => { complete = resolve; });
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, picture);
        return destination;
    } } });
    const msg = record(root);
    cache.prefetch(msg, {});
    await wait_until(() => complete);
    const restore = cache.restore(msg, {});
    complete();
    assert.equal(await restore, true);
    assert.equal(calls, 1);
    assert.deepEqual(await fs.readFile(msg.elements[0].picElement.sourcePath), picture);
    assert.deepEqual(await fs.readFile(path.join(root, "account1", "thumb.png")), picture);
    assert.equal(msg.elements[0].picElement.thumbPath.get(720), msg.elements[0].picElement.sourcePath);
    assert.equal((await fs.readdir(path.join(cache.root, "recalled"))).length, 1);
});

test("重启后用持久缓存恢复图片，替换 QQ 的错误占位文件，不再请求服务器", async t => {
    const { root, cache } = await setup(t, { fetch: async () => picture });
    const msg = record(root);
    assert.equal(await cache.restore(msg, {}), true);
    await fs.writeFile(msg.elements[0].picElement.sourcePath, "{\"retcode\":404}");
    cache.dispose();
    const restarted = new image_cache({ root: cache.root,
        native: { download() { throw new Error("不应再次下载"); }, dispose() {} },
        fetch: () => { throw new Error("不应访问服务器"); } });
    t.after(() => restarted.dispose());
    assert.equal(await restarted.restore(msg, {}), true);
    assert.deepEqual(await fs.readFile(msg.elements[0].picElement.sourcePath), picture);
});

test("错误 HTTP 正文或校验失败不污染 QQ 图片路径", async t => {
    const { root, cache } = await setup(t, { fetch: async () => Buffer.from('<html>expired image</html>') });
    const msg = record(root);
    assert.equal(await cache.restore(msg, {}), false);
    await assert.rejects(fs.stat(msg.elements[0].picElement.sourcePath), { code: "ENOENT" });
    assert.equal((await fs.readdir(path.join(cache.root, "staging"))).length, 0);
});

test("下载队列限流、同图去重、账号路径隔离", async t => {
    let active = 0;
    let peak = 0;
    let calls = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const { root, cache } = await setup(t, { concurrency: 2, fetch: async () => {
        calls++; active++; peak = Math.max(peak, active); await gate; active--; return picture;
    } });
    const one = record(root);
    const another_account = structuredClone(one);
    another_account.elements[0].picElement.sourcePath = path.join(root, "other-account", "same.png");
    const records = [one, another_account, record(root, "3"), record(root, "4")];
    const tasks = records.map(msg => cache.enqueue(msg, msg.elements[0], {}));
    assert.equal(cache.enqueue(one, one.elements[0], {}), tasks[0]);
    await wait_until(() => calls === 2);
    release();
    await Promise.all(tasks);
    assert.equal(calls, 4);
    assert.equal(peak, 2);
    assert.notEqual(cache.key(one, one.elements[0]), cache.key(another_account, another_account.elements[0]));
});

test("临时缓存按时限和容量淘汰，已撤回归档保留", async t => {
    const { cache } = await setup(t, { ttl_ms: 10, staging_bytes: 0 });
    const name = "a".repeat(64) + ".image";
    const staged = path.join(cache.root, "staging", name);
    const kept = path.join(cache.root, "recalled", name);
    await fs.writeFile(staged, picture);
    await fs.writeFile(kept, picture);
    await cache.prune();
    await assert.rejects(fs.stat(staged), { code: "ENOENT" });
    assert.deepEqual(await fs.readFile(kept), picture);
});

test("缺少 sourcePath 的消息仍可稳定命中缓存", async t => {
    let calls = 0;
    const { root, cache } = await setup(t, { fetch: async () => { calls++; return picture; } });
    const msg = record(root);
    delete msg.elements[0].picElement.sourcePath;
    assert.equal(await cache.restore(msg, {}), true);
    assert.equal(await cache.restore(msg, {}), true);
    assert.equal(calls, 1);
});

test("原生下载通过真实渲染进程发送，按窗口、消息与元素匹配完成通知", async () => {
    const native = new native_image({ timeout_ms: 200 });
    const contents = new EventEmitter();
    Object.assign(contents, { id: 7, isDestroyed: () => false });
    let sent;
    contents.send = (...args) => { sent = args; };
    const msg = record("C:/cache");
    let completed = false;
    const task = native.download(contents, msg, msg.elements[0], "C:/cache/image.png").then(value => { completed = true; return value; });
    assert.equal(sent[2].cmdName, "nodeIKernelMsgService/downloadRichMedia");
    assert.equal(sent[2].payload[0].getReq.triggerType, 1);
    const event = { cmdName: "nodeIKernelMsgListener/onRichMediaDownloadComplete", payload: {
        info: [{ msgId: msg.msgId, msgElementId: "wrong", filePath: "wrong" }]
    } };
    native.observe(contents, [{}, event]);
    event.payload.info[0].msgElementId = msg.elements[0].elementId;
    native.observe({ id: 9 }, [{}, event]);
    await tick(); assert.equal(completed, false);
    event.payload.info[0].filePath = "C:/cache/image.png";
    native.observe(contents, [{}, [event]]);
    assert.equal(await task, "C:/cache/image.png");
    assert.equal(contents.listenerCount("destroyed"), 0);
    native.dispose();
});

test("原生下载失败、超时、退出均收敛，不遗留等待项", async () => {
    const native = new native_image({ timeout_ms: 15 });
    const contents = new EventEmitter();
    let header;
    Object.assign(contents, { id: 1, isDestroyed: () => false, send: (_channel, value) => { header = value; } });
    const msg = record("C:/cache");
    const rejected = native.download(contents, msg, msg.elements[0], "C:/cache/a.png");
    native.observe(contents, [header, { result: 5 }]);
    await assert.rejects(rejected, /拒绝/);
    await assert.rejects(native.download(contents, msg, msg.elements[0], "C:/cache/a.png"), /超时/);
    const closed = native.download(contents, msg, msg.elements[0], "C:/cache/a.png");
    native.dispose();
    await assert.rejects(closed, /退出/);
    assert.equal(native.pending.size, 0);
});

function mock_get(status, body, headers = {}) {
    return (_url, callback) => {
        const req = new EventEmitter(); req.destroy = () => {};
        queueMicrotask(() => {
            const response = Readable.from([body]);
            response.statusCode = status; response.headers = headers; callback(response);
        });
        return req;
    };
}

test("HTTP 校验状态码、图片格式、体积、完整性与超时", async () => {
    const url = "https://gchat.qpic.cn/test";
    assert.deepEqual(await fetch_image(url, { get: mock_get(200, picture) }), picture);
    await assert.rejects(fetch_image(url, { get: mock_get(404, picture) }), /404/);
    await assert.rejects(fetch_image(url, { get: mock_get(200, Buffer.from('error: not found')) }), /有效图片/);
    await assert.rejects(fetch_image(url, { get: mock_get(200, picture), max_bytes: 20 }), /大小/);
    await assert.rejects(fetch_image(url, { get: mock_get(200, picture, { "content-length": "999" }) }), /不完整/);
    await assert.rejects(fetch_image(url, { timeout_ms: 10, get: () => Object.assign(new EventEmitter(), { destroy() {} }) }), /超时/);
});

test("HTTP 相对跳转可用，拒绝第三方或无限跳转，不使用空 rkey", async () => {
    let visits = 0;
    const get = (url, callback) => ++visits === 1
        ? mock_get(302, Buffer.alloc(0), { location: "/real-image" })(url, callback)
        : mock_get(200, picture)(url, callback);
    assert.deepEqual(await fetch_image("https://gchat.qpic.cn/a", { get }), picture);
    await assert.rejects(fetch_image("https://gchat.qpic.cn/a", {
        get: mock_get(302, Buffer.alloc(0), { location: "https://example.org/collect" })
    }), /不受支持/);
    await assert.rejects(fetch_image("https://gchat.qpic.cn/a", {
        get: mock_get(302, Buffer.alloc(0), { location: "/loop" })
    }), /跳转/);
    assert.equal(image_urls({ originImageUrl: "/download?appid=1407" }).length, 0);
    assert.match(image_urls({ originImageUrl: "/download?appid=1407&rkey=good" })[0], /^https:\/\/multimedia\.nt\.qq\.com\.cn/);
});

test("插件主进程集成：后台图片已缓存后撤回，立即补发图片更新；历史重新进入也可恢复", async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "qq-recall-main-"));
    const data_root = path.join(root, "data");
    await fs.mkdir(path.join(data_root, "anti_recall"), { recursive: true });
    await fs.writeFile(path.join(data_root, "anti_recall", "config.json"), JSON.stringify({ saveDb: false }));
    const ipc = new EventEmitter(); ipc.handle = () => {};
    const app = new EventEmitter();
    let downloader;
    class isolated_downloader extends ImgDownloader {
        constructor(options) {
            super({ ...options, root: path.join(root, "images") });
            this.cache.fetch = async () => { throw new Error("禁止真实网络"); };
            downloader = this;
        }
    }
    const contents = new EventEmitter();
    const outputs = [];
    let native_calls = 0;
    Object.assign(contents, { id: 8, isDestroyed: () => false, getURL: () => "app://qq/#/main/message" });
    contents.send = (channel, ...args) => {
        outputs.push({ channel, args });
        if (channel === "LiteLoader.anti_recall.native_image_request") {
            native_calls++;
            const request = args[1].payload[0].getReq;
            void fs.mkdir(path.dirname(request.filePath), { recursive: true }).then(() => fs.writeFile(request.filePath, picture)).then(() => {
                void contents.send("RM_IPCFROM_MAIN8", {}, {
                    cmdName: "nodeIKernelMsgListener/onRichMediaDownloadComplete", payload: { info: [{
                        msgId: request.msgId, msgElementId: request.elementId, filePath: request.filePath, fileErrCode: 0
                    }] }
                });
            });
        }
    };
    const context = { module: { exports: {} }, console: { log() {} }, LiteLoader: { path: { data: data_root } },
        require: name => name === "electron" ? { app, ipcMain: ipc, dialog: {} }
            : name === "./imgDownloader.js" ? { ImgDownloader: isolated_downloader }
                : name === "./viewer/recall_viewer.js" ? { recall_viewer: class { remember() {} clear() {} } }
                : name === "level-party" ? () => {} : require(name) };
    vm.runInNewContext(fs_sync.readFileSync(path.join(__dirname, "../anti-recall-repair/main.js"), "utf8"), context);
    const window = { webContents: contents, isDestroyed: () => false };
    context.module.exports.onBrowserWindowCreated(window);
    contents.emit("did-stop-loading");
    t.after(async () => { downloader.dispose(); await fs.rm(root, { recursive: true, force: true }); });
    const msg = record(root);
    await contents.send("RM_IPCFROM_MAIN8", {}, { cmdName: "nodeIKernelMsgListener/onRecvMsg", payload: { msgList: [msg] } });
    await wait_until(() => native_calls === 1 && downloader.cache.jobs.size === 0);
    await fs.unlink(msg.elements[0].picElement.sourcePath);
    const recalled = { msgId: msg.msgId, peerUid: msg.peerUid, msgType: 5, subMsgType: 4, sendStatus: 2, msgSeq: "123",
        elements: [{ grayTipElement: { revokeElement: { isSelfOperate: false } } }] };
    await contents.send("RM_IPCFROM_MAIN8", {}, { cmdName: "nodeIKernelMsgListener/onMsgInfoListUpdate", payload: { msgList: [recalled] } });
    const update = outputs.findLast(item => item.args[1]?.cmdName === "nodeIKernelMsgListener/onMsgInfoListUpdate");
    assert.equal(update.args[1].payload.msgList[0].msgType, 2);
    assert.equal(update.args[1].payload.msgList[0].msgSeq, "123");
    assert.equal(native_calls, 1);
    const history = { msgList: [structuredClone(recalled)] };
    await contents.send("RM_IPCFROM_MAIN8", {}, history);
    assert.equal(history.msgList[0].msgType, 2);
    assert.deepEqual(await fs.readFile(msg.elements[0].picElement.sourcePath), picture);
});
