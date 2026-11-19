"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

// 用溢出的会话列表和长消息验证真实滚轮、滚动条拖动及两栏独立滚动。
async function main() {
    const browser = await chromium.launch({ channel: "msedge", headless: true, ignoreDefaultArgs: ["--hide-scrollbars"] });
    try {
        const page = await browser.newPage({ viewport: { width: 1024, height: 720 }, colorScheme: "dark" });
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        const root = path.resolve("anti-recall-repair/viewer");
        await page.route("https://recall-scroll.test/**", route => {
            const name = new URL(route.request().url()).pathname.slice(1) || "viewer.html";
            const file = path.resolve(root, name);
            assert.ok(file.startsWith(root + path.sep));
            return route.fulfill({ contentType: name.endsWith(".css") ? "text/css" : name.endsWith(".js") ? "text/javascript" : "text/html", body: fs.readFileSync(file) });
        });
        await page.addInitScript(() => {
            const ok = data => ({ ok: true, data });
            const conversations = Array.from({ length: 40 }, (_, index) => ({
                id: "group" + index, title: "会话滚动测试 " + (index + 1), peer_number: String(100000 + index),
                chat_type: 2, count: 3, preview: "包含长消息与多行文本的已撤回记录"
            }));
            window.recall_history = {
                list: async () => ok({ total: 120, matched: 120, conversations, saved: true, warning: "" }),
                messages: async () => ok({ total: 3, next_offset: null, records: Array.from({ length: 3 }, (_, index) => ({
                    id: "message" + index, sender_name: "测试发送者", sender_number: "10001", sent_at: 1700000000000 + index * 1000,
                    parts: [{ type: "text", text: ("这是一段用于检查滚动的长消息，第 " + (index + 1) + " 条。\n").repeat(35) }]
                })) }),
                media: async () => ({ ok: false, error: "没有图片" }), jump: async () => ok({ dispatched: true }), changed: () => {}
            };
        });
        await page.goto("https://recall-scroll.test/");
        await page.locator(".message").last().waitFor();

        for (const viewport of [{ width: 1024, height: 720 }, { width: 786, height: 500 }, { width: 1440, height: 900 }]) {
            await page.setViewportSize(viewport);
            const layout = await page.evaluate(() => {
                const box = id => {
                    const element = document.getElementById(id);
                    const rect = element.getBoundingClientRect();
                    return { client: element.clientHeight, scroll: element.scrollHeight, top: rect.top, bottom: rect.bottom };
                };
                return { height: innerHeight, sidebar: document.querySelector(".sidebar").getBoundingClientRect().height,
                    main: document.querySelector("main").getBoundingClientRect().height, left: box("conversations"), right: box("timeline"),
                    left_footer: document.querySelector(".sidebar-footer").getBoundingClientRect().bottom,
                    right_footer: document.querySelector(".chat-footer").getBoundingClientRect().bottom,
                    horizontal_overflow: document.documentElement.scrollWidth > innerWidth };
            });
            assert.ok(layout.sidebar <= viewport.height + 1, "左栏被内容撑出窗口：" + JSON.stringify(layout));
            assert.ok(layout.main <= viewport.height + 1, "右栏被内容撑出窗口：" + JSON.stringify(layout));
            assert.ok(layout.left.scroll > layout.left.client, "会话列表未形成独立滚动区域");
            assert.ok(layout.right.scroll > layout.right.client, "消息列表未形成独立滚动区域");
            assert.ok(layout.left_footer <= viewport.height + 1 && layout.right_footer <= viewport.height + 1, "底栏被裁切");
            assert.equal(layout.horizontal_overflow, false);

            await page.evaluate(() => {
                document.getElementById("conversations").scrollTop = 0;
                document.getElementById("timeline").scrollTop = 0;
            });
            const left_box = await page.locator("#conversations").boundingBox();
            await page.mouse.move(left_box.x + left_box.width / 2, left_box.y + left_box.height / 2);
            await page.mouse.wheel(0, 600);
            await page.waitForFunction(() => document.getElementById("conversations").scrollTop > 100);
            const left_scrolled = await page.locator("#conversations").evaluate(element => element.scrollTop);
            assert.equal(await page.locator("#timeline").evaluate(element => element.scrollTop), 0);
            const right_box = await page.locator("#timeline").boundingBox();
            await page.mouse.move(right_box.x + right_box.width / 2, right_box.y + right_box.height / 2);
            await page.mouse.wheel(0, 600);
            await page.waitForFunction(() => document.getElementById("timeline").scrollTop > 100);
            assert.equal(await page.locator("#conversations").evaluate(element => element.scrollTop), left_scrolled);

            for (const id of ["conversations", "timeline"]) {
                await page.locator("#" + id).evaluate(element => { element.scrollTop = 0; });
                const track = await page.locator("#" + id).evaluate(element => {
                    const rect = element.getBoundingClientRect();
                    const thumb = Math.max(24, element.clientHeight * element.clientHeight / element.scrollHeight);
                    return { x: rect.right - 5, start: rect.top + thumb / 2, end: rect.bottom + 20 };
                });
                await page.mouse.move(track.x, track.start);
                await page.mouse.down();
                await page.mouse.move(track.x, track.end, { steps: 15 });
                await page.mouse.up();
                try {
                    await page.waitForFunction(id => {
                        const element = document.getElementById(id);
                        return element.scrollTop >= element.scrollHeight - element.clientHeight - 10;
                    }, id, { timeout: 2000 });
                } catch (error) {
                    console.error("滚动条拖动失败", id, await page.locator("#" + id).evaluate(element => ({
                        top: element.scrollTop, height: element.clientHeight, scroll: element.scrollHeight,
                        width: element.clientWidth, offset_width: element.offsetWidth
                    })));
                    await page.screenshot({ path: "artifacts/anti-recall-scroll-test-failure.png" });
                    throw error;
                }
            }
            await page.locator(".conversation").last().waitFor({ state: "visible" });
        }
        await page.screenshot({ path: "artifacts/anti-recall-viewer-scroll-fixed.png" });
        assert.deepEqual(errors, []);
        console.log("PASS: 三种窗口大小下，左右栏真实滚轮滚动、独立滚动、拖动原生滚动条到底、底栏常驻且无横向溢出。");
    } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
