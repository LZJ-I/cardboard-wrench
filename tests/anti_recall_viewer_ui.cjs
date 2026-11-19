"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { recall_catalog } = require("../anti-recall-repair/viewer/recall_catalog");

async function main() {
    const catalog = new recall_catalog({ register_asset: () => "demo-image" });
    for (let index = 0; index < 110; index++) catalog.remember({ msg: {
        msgId: String(90071992547409930n + BigInt(index)), chatType: 2, peerUid: "123456789", peerUin: "123456789",
        peerName: "周末摄影交流群", sendMemberName: ["林间", "阿澄", "小夏"][index % 3], senderUin: "10001",
        msgTime: String(1700000000 + index * 3600), elements: [
            { textElement: { content: index === 109 ? "关键记录：今天拍的风景，原图留在这里。" : index === 108
                ? '<img src=x onerror="window.injected=true">' : `大家讨论的第 ${index + 1} 条消息。` } },
            ...(index === 109 ? [{ picElement: {} }] : [])
        ]
    } });
    catalog.remember({ msg: { msgId: "friend", chatType: 1, peerUid: "u_friend", peerUin: "10002", peerName: "陈同学",
        sendNickName: "陈同学", msgTime: "1699999999", elements: [{ textElement: { content: "明天见，资料已经发给你啦。" } }] } });
    const browser = await chromium.launch({ channel: "msedge", headless: true });
    const errors = [];
    const root = path.resolve("anti-recall-repair/viewer");
    try {
        const page = await browser.newPage({ viewport: { width: 1040, height: 730 }, colorScheme: "dark" });
        page.on("pageerror", error => errors.push(error.message));
        await page.route("https://recall-viewer.test/**", route => {
            const name = new URL(route.request().url()).pathname.slice(1) || "viewer.html";
            const file = path.resolve(root, name);
            assert.ok(file.startsWith(root + path.sep));
            const type = name.endsWith(".css") ? "text/css" : name.endsWith(".js") ? "text/javascript" : "text/html";
            return route.fulfill({ contentType: type, body: fs.readFileSync(file) });
        });
        await page.exposeFunction("mock_list", query => catalog.list(query));
        await page.exposeFunction("mock_messages", options => catalog.messages(options));
        await page.addInitScript(() => {
            window.mock_jumps = [];
            window.mock_media = [];
            window.mock_failure = "";
            const ok = data => ({ ok: true, data });
            window.recall_history = {
                list: async options => ok({ ...await window.mock_list(options.query), saved: true, warning: window.mock_failure }),
                messages: async options => ok(await window.mock_messages(options)),
                media: async options => {
                    window.mock_media.push(options);
                    if (window.image_missing) return { ok: false, error: "本地图片未保存" };
                    return ok({ url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9sAAAAASUVORK5CYII=" });
                },
                jump: async id => { window.mock_jumps.push(id); return window.jump_failure ? { ok: false, error: window.jump_failure } : ok({ dispatched: true }); },
                changed: callback => { window.mock_changed = callback; }
            };
        });
        await page.goto("https://recall-viewer.test/");
        await page.locator(".message").last().waitFor();
        assert.equal(await page.locator(".conversation").count(), 2);
        assert.equal(await page.locator(".message").count(), 50);
        assert.match(await page.locator("#totals").innerText(), /111 条/);
        assert.match(await page.locator("#chat-title").innerText(), /摄影/);
        assert.equal(await page.locator(".text-part img").count(), 0);
        assert.equal(await page.evaluate(() => window.injected), undefined);
        await page.locator(".image-button img").waitFor();

        await page.getByRole("button", { name: "加载更早的记录" }).click();
        assert.equal(await page.locator(".message").count(), 100);
        await page.getByRole("button", { name: "加载更早的记录" }).click();
        assert.equal(await page.locator(".message").count(), 110);
        assert.equal(await page.locator("#load-more").isVisible(), false);

        await page.getByRole("searchbox", { name: "搜索撤回记录" }).fill("关键记录");
        await page.waitForFunction(() => document.querySelectorAll(".message").length === 1);
        assert.equal(await page.locator(".conversation").count(), 1);
        const current = page.locator(".message");
        const id = await current.getAttribute("data-message");
        await current.locator(".bubble").dblclick();
        assert.deepEqual(await page.evaluate(() => window.mock_jumps), [id]);
        assert.match(await page.locator("#toast").innerText(), /已请求/);

        await page.getByRole("button", { name: "放大撤回图片" }).click();
        await page.locator("#image-preview[open]").waitFor();
        await page.waitForFunction(() => document.querySelector("#full-image").hasAttribute("src"));
        assert.equal(await page.evaluate(() => window.mock_media.some(call => call.full === true)), true);
        await page.getByRole("button", { name: "关闭图片预览" }).click();
        await page.evaluate(() => { window.mock_media = []; window.mock_jumps = []; });
        await page.getByRole("button", { name: "放大撤回图片" }).dblclick({ delay: 70 });
        await page.waitForTimeout(350);
        assert.deepEqual(await page.evaluate(() => window.mock_jumps), [id]);
        assert.equal(await page.locator("#image-preview").evaluate(dialog => dialog.open), false);
        assert.equal(await page.evaluate(() => window.mock_media.some(call => call.full)), false);

        await page.evaluate(() => { window.jump_failure = "没有找到 QQ 主窗口"; });
        await current.focus(); await page.keyboard.press("Enter");
        assert.match(await page.locator("#toast").innerText(), /没有找到 QQ 主窗口/);
        await page.evaluate(() => { window.jump_failure = ""; });

        await page.getByRole("searchbox").fill("没有这条消息");
        await page.getByText("没有找到匹配的记录", { exact: true }).waitFor();
        assert.equal(await page.locator(".message").count(), 0);
        await page.getByRole("searchbox").fill("");
        await page.waitForFunction(() => document.querySelectorAll(".message").length === 50);
        await page.locator(".conversation").filter({ hasText: "陈同学" }).click();
        await page.locator("#messages").getByText("明天见，资料已经发给你啦。", { exact: true }).waitFor();
        assert.equal(await page.locator(".message").count(), 1);
        await page.evaluate(() => { window.mock_failure = "历史记录读取失败：模拟错误"; });
        await page.getByRole("button", { name: "刷新记录" }).click();
        assert.match(await page.locator("#warning").innerText(), /模拟错误/);

        await page.evaluate(() => { window.mock_failure = ""; window.image_missing = true; });
        await page.locator(".conversation").filter({ hasText: "摄影" }).click();
        await page.getByText("图片未保存或已清理", { exact: true }).waitFor();
        await page.evaluate(() => { window.image_missing = false; });
        await page.getByRole("button", { name: "刷新记录" }).click();
        await page.locator(".image-button img").waitFor();
        await page.setViewportSize({ width: 786, height: 594 });
        await page.locator("#timeline").evaluate(element => { element.scrollTop = element.scrollHeight; });
        await page.evaluate(() => { document.getElementById("toast").hidden = true; });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.screenshot({ path: "artifacts/anti-recall-viewer-preview.png" });
        assert.deepEqual(errors, []);
        console.log("PASS: 分组、50 条分页、搜索、纯文本安全渲染、单击图片预览、双击消息与图片定位、键盘定位、空结果、缺失图片和数据库错误、窄窗口布局。");
    } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
