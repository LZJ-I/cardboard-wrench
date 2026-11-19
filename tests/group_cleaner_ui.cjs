"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

async function main() {
    const browser = await chromium.launch({ channel: "msedge", headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1040, height: 960 }, colorScheme: "dark" });
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        const root = path.resolve("group-cleaner");
        await page.route("https://group-cleaner.test/**", route => {
            const relative = new URL(route.request().url()).pathname.slice(1);
            if (!relative) return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{margin:0;background:#1c212a}</style><body><div id="mount"></div><script type="module">import {onSettingWindowCreated} from "/renderer.mjs";onSettingWindowCreated(document.querySelector("#mount"));</script></body></html>' });
            const file = path.resolve(root, relative);
            assert.ok(file.startsWith(root + path.sep));
            return route.fulfill({ contentType: relative.endsWith(".mjs") ? "text/javascript" : relative.endsWith(".css") ? "text/css" : "text/html", body: fs.readFileSync(file, "utf8") });
        });
        await page.addInitScript(() => {
            window.mock_calls = [];
            window.mock_calibration_state = { ready: true, active: false, message: "演示校准已就绪" };
            window.mock_groups = Array.from({ length: 80 }, (_, index) => ({
                id: String(100000 + index), name: `演示群 ${String(index).padStart(2, "0")}`,
                remark: index === 7 ? "重要项目" : "", members: 50 + index,
                role: index === 0 ? "owner" : "member", owner: index === 0,
                role_known: true, retained: index === 1
            }));
            window.mock_groups[2].name = '<img src=x onerror="window.xss=true">';
            const ok = data => ({ ok: true, data });
            window.group_cleaner = {
                state: async () => ok({ groups: window.mock_groups, account: "u_demo", job: null, updated_at: 1, calibration: window.mock_calibration_state }),
                refresh: async () => ok({ groups: window.mock_groups, account: "u_demo", job: null, updated_at: 1, calibration: window.mock_calibration_state }),
                calibrate: async () => {
                    window.mock_progress(null);
                    window.mock_calibration_state = { ready: false, active: true, message: "等待原生退群" };
                    return ok({ groups: window.mock_groups, account: "u_demo", job: null, updated_at: 1, calibration: window.mock_calibration_state });
                },
                cancel_calibration: async () => { window.mock_calibration_state = { ready: false, active: false, message: "已停止校准" }; return ok(window.mock_calibration_state); },
                retain: async (id, retained) => { window.mock_groups.find(group => group.id === id).retained = retained; return ok({ groups: window.mock_groups, updated_at: 1 }); },
                open_group: async id => { window.mock_calls.push({ method: "open_group", id }); return ok({ opened: true }); },
                prepare: async ids => { window.mock_calls.push({ method: "prepare", ids }); return ok({ token: "mock-token", groups: ids.map(id => ({ id, name: "演示" })) }); },
                start: async token => { window.mock_calls.push({ method: "start", token }); return ok({ cancelled: true }); },
                stop: async () => { window.mock_calls.push({ method: "stop" }); return ok({ ok: true }); },
                on_progress: callback => { window.mock_progress = callback; return () => {}; },
                on_calibration: callback => { window.mock_calibration = callback; return () => {}; },
                on_account_changed: callback => { window.mock_account_changed = callback; return () => {}; }
            };
        });
        await page.goto("https://group-cleaner.test/");
        await page.locator(".group-row").last().waitFor();
        assert.equal(await page.locator(".group-row").count(), 80);
        assert.equal(await page.locator(".group-row img").count(), 0);
        assert.equal(await page.evaluate(() => window.xss), undefined);
        assert.equal(await page.locator('.group-row[data-id="100000"] input').isDisabled(), true);
        assert.equal(await page.locator('.group-row[data-id="100001"] input').isDisabled(), true);
        await page.getByRole("searchbox").fill("重要项目");
        assert.equal(await page.locator(".group-row").count(), 1);
        await page.getByRole("searchbox").fill("");
        const target = page.locator('.group-row[data-id="100007"]');
        await target.locator('input[type="checkbox"]').check();
        await target.getByRole("button", { name: "保留", exact: true }).click();
        assert.equal(await target.locator("input").isDisabled(), true);
        assert.match(await page.locator('[data-stat="selected"]').innerText(), /0/);
        await target.getByRole("button", { name: "已保留", exact: true }).click();
        await target.locator('input[type="checkbox"]').check();
        await target.getByRole("button", { name: "打开群聊 演示群 07", exact: true }).click();
        assert.equal(await target.locator('input[type="checkbox"]').isChecked(), true);
        assert.deepEqual(await page.evaluate(() => window.mock_calls), [{ method: "open_group", id: "100007" }]);
        await page.evaluate(() => { window.mock_calls = []; });
        await target.getByRole("button", { name: "退群", exact: true }).click();
        assert.deepEqual(await page.evaluate(() => window.mock_calls.map(call => call.method)), ["prepare", "start"]);
        assert.deepEqual(await page.evaluate(() => window.mock_calls[0].ids), ["100007"]);
        await page.locator('.group-list').evaluate(list => { list.scrollTop = 1100; });
        const before = await page.locator('.group-list').evaluate(list => {
            const top = list.getBoundingClientRect().top;
            const row = [...list.children].find(row => row.getBoundingClientRect().bottom > top);
            return { id: row.dataset.id, offset: row.getBoundingClientRect().top - top };
        });
        await page.evaluate(() => window.mock_progress({
            account: "u_demo", running: false, total: 1, completed: 1, items: [
                { id: "100003", name: "演示群 03", status: "success", message: "已退出" }
            ]
        }));
        const after = await page.locator('.group-list').evaluate(list => {
            const top = list.getBoundingClientRect().top;
            const row = [...list.children].find(row => row.getBoundingClientRect().bottom > top);
            return { id: row.dataset.id, offset: row.getBoundingClientRect().top - top };
        });
        assert.equal(after.id, before.id);
        assert.ok(Math.abs(after.offset - before.offset) < 2, JSON.stringify({ before, after }));
        assert.equal(await page.locator(".group-row").count(), 79);
        await page.evaluate(() => window.mock_progress({
            account: "u_demo", running: false, stop_requested: true, total: 1, completed: 1,
            items: [{ id: "100005", name: "演示群 05", status: "failed", message: "退群失败：QQ 返回错误码 4；未自动重试" }]
        }));
        assert.match(await page.locator('[data-part="notice"]').innerText(), /错误码 4/);
        assert.equal(await page.locator('[data-part="results"]').evaluate(node => node.open), true);
        await page.locator('.group-list').evaluate(list => { list.scrollTop = 0; });
        await page.getByRole("searchbox").fill("演示群");
        await page.evaluate(() => window.mock_progress({
            account: "u_demo", running: true, stop_requested: false, total: 1, completed: 0,
            items: [{ id: "100005", name: "演示群 05", status: "leaving", message: "等待 QQ 返回结果" }]
        }));
        await page.getByRole("button", { name: "停止后续操作" }).click();
        assert.equal(await page.evaluate(() => window.mock_calls.at(-1).method), "stop");
        assert.equal(await page.getByRole("searchbox").inputValue(), "演示群");
        const visible_before_reset = await page.locator(".group-row").count();
        await page.evaluate(() => window.mock_progress(null));
        assert.equal(await page.locator(".group-row").count(), visible_before_reset);
        assert.equal(await page.locator('[data-part="progress"]').innerText(), "请选择要退出的群聊");
        await page.evaluate(() => window.mock_account_changed());
        assert.equal(await page.locator(".group-row").count(), 0);
        await page.getByRole("button", { name: "刷新群列表" }).click();
        await page.getByRole("searchbox").fill("演示群");
        await page.evaluate(() => window.mock_calibration({ ready: false, active: false, message: "需要校准" }));
        assert.equal(await page.locator('.group-row[data-id="100007"] [data-action="leave-one"]').isDisabled(), true);
        assert.equal(await page.locator('.group-row[data-id="100007"] [data-action="open-group"]').isDisabled(), false);
        await page.getByRole("button", { name: "开始校准退群", exact: true }).click();
        assert.ok(await page.locator(".group-row").count() > 0, "校准开始后的空任务通知不能清空群列表");
        assert.equal(await page.getByRole("button", { name: "停止校准", exact: true }).isVisible(), true);
        await page.getByRole("button", { name: "停止校准", exact: true }).click();
        await page.evaluate(() => window.mock_calibration({ ready: true, active: false, message: "演示校准成功" }));
        assert.equal(await page.locator('.group-row[data-id="100007"] [data-action="leave-one"]').isDisabled(), false);
        fs.mkdirSync("artifacts", { recursive: true });
        await page.screenshot({ path: "artifacts/group-cleaner-preview.png", fullPage: true });
        await page.setViewportSize({ width: 560, height: 900 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "面板不应横向溢出");
        await page.screenshot({ path: "artifacts/group-cleaner-narrow.png", fullPage: true });
        assert.deepEqual(errors, []);
        console.log("PASS: 离线界面渲染、群名点击、保留选择、错误码 4 可见反馈、身份保护、搜索、保留切换、取消确认、精确退群名单、滚动锚定、停止按钮、账号切换及窄窗口布局。未连接 QQ。");
    } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
