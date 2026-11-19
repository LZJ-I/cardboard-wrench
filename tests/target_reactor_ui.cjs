"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { load_catalog } = require("../target-reactor/lib/emoji_catalog");
const { validate_config } = require("../target-reactor/lib/rules");

async function main() {
    const { QQNT_RESOURCES, QQNT_DOCUMENTS } = process.env;
    assert.ok(QQNT_RESOURCES && QQNT_DOCUMENTS, "请设置 QQNT_RESOURCES 和 QQNT_DOCUMENTS");
    const catalog = load_catalog({ resources: QQNT_RESOURCES, documents: QQNT_DOCUMENTS });
    assert.ok(catalog.some(item => item.id === "128541"));
    let config = { enabled: false, rules: [] };
    let account = "u_demo";
    let errors = {};
    const saves = [];
    const snapshot = include_catalog => ({ account, config, ...(include_catalog ? { catalog } : {}), stats: { success: 0, failed: 0, skipped: 0 },
        errors, queued: 0, busy: false, events: [], recent: [{ id: "12345678", name: "测试群", members: [{ id: "10001", name: "测试成员" }] }] });
    const browser = await chromium.launch({ channel: "msedge", headless: true, ignoreDefaultArgs: ["--hide-scrollbars"] });
    try {
        const page = await browser.newPage({ viewport: { width: 1100, height: 1000 }, colorScheme: "dark" });
        const page_errors = [];
        page.on("pageerror", error => page_errors.push(error.message));
        const root = path.resolve("target-reactor");
        await page.route("https://target-reactor.test/**", route => {
            const name = new URL(route.request().url()).pathname.slice(1);
            if (!name) return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{margin:0;background:#171c25}</style><div id="mount"></div><script type="module">import {onSettingWindowCreated} from "/renderer.mjs";onSettingWindowCreated(document.getElementById("mount"));</script></html>' });
            const file = path.resolve(root, name); assert.ok(file.startsWith(root + path.sep));
            return route.fulfill({ contentType: name.endsWith(".mjs") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html", body: fs.readFileSync(file) });
        });
        await page.exposeFunction("mock_state", include_catalog => ({ ok: true, data: snapshot(include_catalog) }));
        await page.exposeFunction("mock_save", value => {
            try { config = validate_config(value, catalog); errors = {}; saves.push(structuredClone(config)); return { ok: true, data: snapshot(false) }; }
            catch (error) { return { ok: false, error: error.message }; }
        });
        await page.addInitScript(() => {
            window.target_reactor = { state: value => window.mock_state(value), save: value => window.mock_save(value), changed: callback => { window.mock_changed = callback; return () => {}; } };
        });
        await page.goto("https://target-reactor.test/");
        await page.locator('[data-part="chosen"]').getByText("已选：吐舌", { exact: true }).waitFor();
        assert.equal(await page.locator('[data-input="enabled"]').isChecked(), false);
        assert.equal(await page.locator(".emoji-choice").count(), catalog.length);
        await page.getByRole("button", { name: "添加规则", exact: true }).click();
        await page.getByText("请输入正确的群号", { exact: true }).waitFor();
        assert.equal(config.rules.length, 0);
        await page.locator('[data-input="group"]').fill("12345678");
        await page.locator('[data-input="member"]').fill("10001");
        await page.locator('[data-input="label"]').fill('<img src=x onerror="window.injected=true">');
        await page.getByRole("button", { name: "添加规则", exact: true }).click();
        await page.locator(".rule").waitFor();
        assert.equal(config.rules.length, 1); assert.equal(config.enabled, false); assert.equal(config.rules[0].emoji_id, "128541");
        assert.equal(await page.locator(".rule-name img").count(), 0); assert.equal(await page.evaluate(() => window.injected), undefined);
        await page.locator('[data-input="enabled"]').check();
        await page.waitForFunction(() => document.querySelector("#mount").shadowRoot.querySelector('[data-part="notice"]').textContent.includes("之后收到的新消息"));
        assert.equal(config.enabled, true);
        await page.locator(".rule").getByRole("button", { name: "暂停", exact: true }).click();
        await page.getByText("规则暂停", { exact: true }).waitFor(); assert.equal(config.rules[0].enabled, false);
        await page.locator(".rule").getByRole("button", { name: "启用", exact: true }).click();
        await page.getByText("规则启用", { exact: true }).waitFor();
        await page.locator(".rule").getByRole("button", { name: "编辑", exact: true }).click();
        assert.equal(await page.locator('[data-input="member"]').inputValue(), "10001");
        await page.locator('[data-input="label"]').fill("摄影群 · 小林");
        await page.locator('[data-input="emoji-search"]').fill("吐舌");
        assert.ok(await page.locator(".emoji-choice").count() >= 1);
        await page.getByRole("button", { name: "保存修改", exact: true }).click();
        await page.getByText("摄影群 · 小林", { exact: true }).waitFor();
        assert.equal(config.rules.length, 1);

        errors = { [config.rules[0].id]: "QQ 返回错误码 5；未自动重试" }; config.rules[0].enabled = false;
        await page.evaluate(() => window.mock_changed());
        await page.getByText("出错暂停", { exact: true }).waitFor();
        await page.getByRole("button", { name: "恢复规则", exact: true }).click();
        await page.getByText("规则启用", { exact: true }).waitFor(); assert.equal(config.rules[0].enabled, true);

        await page.locator('[data-input="emoji-search"]').fill("");
        assert.equal(await page.locator('[data-part="emojis"]').evaluate(element => element.scrollHeight > element.clientHeight), true);
        for (let index = 0; index < 12; index++) config.rules.push({ ...config.rules[0], id: "extra" + index, member_id: String(20000 + index), label: "其它规则 " + index });
        await page.evaluate(() => window.mock_changed());
        await page.waitForFunction(() => document.querySelector("#mount").shadowRoot.querySelectorAll(".rule").length === 13);
        assert.equal(await page.locator('[data-part="rules"]').evaluate(element => element.scrollHeight > element.clientHeight), true);
        await page.screenshot({ path: "artifacts/target-reactor-preview.png", fullPage: true });
        await page.locator(".rule").first().getByRole("button", { name: "删除", exact: true }).click();
        await page.waitForFunction(() => document.querySelector("#mount").shadowRoot.querySelectorAll(".rule").length === 12);
        assert.equal(config.rules.length, 12);
        await page.setViewportSize({ width: 680, height: 800 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        account = "u_other"; config = { enabled: false, rules: [] }; errors = {};
        await page.evaluate(() => window.mock_changed());
        await page.waitForFunction(() => document.querySelector("#mount").shadowRoot.querySelectorAll(".rule").length === 0);
        assert.equal(await page.locator('[data-input="enabled"]').isChecked(), false);
        assert.ok(saves.length >= 6); assert.deepEqual(page_errors, []);
        console.log("PASS: 默认关闭、😝 图形选择、规则校验、添加/编辑/暂停/恢复、总开关、错误反馈、账号切换、滚动和窄窗口布局；全部为模拟接口。");
    } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
