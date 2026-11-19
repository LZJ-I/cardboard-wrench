"use strict";

// 本页面拥有搜索、会话选择、分页和图片预览状态；消息内容一律按纯文本渲染。
const api = window.recall_history;
const by_id = id => document.getElementById(id);
const state = { query: "", conversations: [], selected: null, records: [], next: null, revision: 0 };
const image_queue = [];
let active_images = 0;
let search_timer;
let notice_timer;
let preview_timer;
let preview_revision = 0;
const image_observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
        image_observer.unobserve(entry.target);
        image_queue.push(entry.target);
        drain_images();
    }
}, { root: by_id("timeline"), rootMargin: "200px" });

function node(tag, class_name, value) {
    const element = document.createElement(tag);
    if (class_name) element.className = class_name;
    if (value !== undefined) element.textContent = value;
    return element;
}

async function request(promise) {
    const result = await promise;
    if (!result?.ok) throw new Error(result?.error || "读取失败，请重试");
    return result.data;
}

function notify(message) {
    clearTimeout(notice_timer);
    by_id("toast").textContent = message;
    by_id("toast").hidden = false;
    notice_timer = setTimeout(() => { by_id("toast").hidden = true; }, 4500);
}

function date_text(time) {
    return time ? new Date(time).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" }) : "时间未知";
}

function render_conversations() {
    const container = by_id("conversations");
    container.replaceChildren();
    for (const conversation of state.conversations) {
        const button = node("button", "conversation" + (conversation.id === state.selected ? " active" : ""));
        button.type = "button";
        button.dataset.conversation = conversation.id;
        button.setAttribute("aria-pressed", String(conversation.id === state.selected));
        const icon = node("span", "icon", conversation.chat_type === 2 ? "群" : "聊");
        const info = node("div", "info");
        const name = node("div", "name");
        name.append(node("span", "", conversation.title), node("span", "count", conversation.count));
        info.append(name, node("p", "", conversation.preview));
        button.append(icon, info);
        button.addEventListener("click", () => {
            if (state.selected === conversation.id) return;
            state.selected = conversation.id;
            render_conversations();
            void load_messages().catch(error => notify(error.message));
        });
        container.append(button);
    }
    if (!state.conversations.length) container.append(node("p", "sidebar-empty", state.query ? "没有匹配的会话或消息" : "暂无已保存的撤回记录"));
}

function show_empty(title, description) {
    by_id("empty").hidden = false;
    by_id("empty").querySelector("h3").textContent = title;
    by_id("empty").querySelector("p").textContent = description;
}

function drain_images() {
    while (active_images < 3 && image_queue.length) {
        const button = image_queue.shift();
        if (!button.isConnected) continue;
        active_images++;
        void load_image(button).finally(() => { active_images--; drain_images(); });
    }
}

async function load_image(button) {
    if (!button.isConnected) return;
    try {
        const data = await request(api.media({ asset_id: button.dataset.asset }));
        if (!button.isConnected) return;
        const timeline = by_id("timeline");
        const at_bottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80;
        const image = node("img");
        image.src = data.url;
        image.alt = "已保存的撤回图片";
        image.addEventListener("error", () => {
            button.classList.add("failed");
            button.replaceChildren(node("span", "image-state", "此图片无法预览，双击消息到 QQ 查看"));
        }, { once: true });
        button.replaceChildren(image);
        image.addEventListener("load", () => { if (at_bottom) timeline.scrollTop = timeline.scrollHeight; }, { once: true });
    } catch (error) {
        button.classList.add("failed");
        button.replaceChildren(node("span", "image-state", "图片未保存或已清理"));
        button.title = error.message;
    }
}

async function preview_image(asset_id) {
    const revision = ++preview_revision;
    by_id("full-image").removeAttribute("src");
    by_id("preview-state").textContent = "正在读取本地图片…";
    if (!by_id("image-preview").open) by_id("image-preview").showModal();
    try {
        const image = await request(api.media({ asset_id, full: true }));
        if (revision !== preview_revision || !by_id("image-preview").open) return;
        by_id("full-image").src = image.url;
        by_id("preview-state").textContent = "按 Esc 关闭";
    } catch (error) {
        if (revision === preview_revision) by_id("preview-state").textContent = error.message;
    }
}

async function jump(record) {
    clearTimeout(preview_timer);
    if (by_id("image-preview").open) by_id("image-preview").close();
    try {
        await request(api.jump(record.id));
        notify("已请求在 QQ 原会话中定位这条消息");
    } catch (error) { notify(error.message); }
}

function message_node(record) {
    const article = node("article", "message");
    article.tabIndex = 0;
    article.dataset.message = record.id;
    article.title = "双击在 QQ 中定位此消息；Enter 也可定位";
    article.append(node("span", "avatar", record.sender_name.slice(0, 1)));
    const content = node("div", "message-content");
    const header = node("div", "message-header");
    const sender = node("span", "sender", record.sender_name);
    sender.title = record.sender_number || record.sender_name;
    const time = node("time", "", record.sent_at ? new Date(record.sent_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "时间未知");
    if (record.sent_at) time.dateTime = new Date(record.sent_at).toISOString();
    header.append(sender, time, node("span", "recall-badge", "已撤回"));
    const bubble = node("div", "bubble");
    for (const part of record.parts) {
        if (part.type === "image") {
            const button = node("button", "image-button");
            button.type = "button";
            button.dataset.asset = part.asset_id;
            button.setAttribute("aria-label", "放大撤回图片");
            button.append(node("span", "image-state", "正在读取图片…"));
            button.addEventListener("click", event => {
                clearTimeout(preview_timer);
                if (event.detail < 2) preview_timer = setTimeout(() => { void preview_image(part.asset_id); }, 280);
            });
            bubble.append(button);
            image_observer.observe(button);
        } else bubble.append(node("div", part.type === "text" ? "text-part" : "attachment", part.text));
    }
    content.append(header, bubble, node("p", "jump-hint", "双击定位到原会话中的这条消息"));
    article.append(content);
    article.addEventListener("dblclick", () => { void jump(record); });
    article.addEventListener("keydown", event => {
        if (event.key === "Enter" && event.target === article) { event.preventDefault(); void jump(record); }
    });
    return article;
}

function render_messages() {
    image_observer.disconnect();
    const container = by_id("messages");
    container.replaceChildren();
    let day = "";
    for (const record of state.records) {
        const date = date_text(record.sent_at);
        if (date !== day) { day = date; container.append(node("div", "day", date)); }
        container.append(message_node(record));
    }
}

async function load_messages(older = false) {
    const revision = ++state.revision;
    const conversation = state.conversations.find(item => item.id === state.selected);
    if (!conversation) {
        state.records = []; render_messages(); by_id("load-more").hidden = true;
        by_id("chat-title").textContent = "撤回消息查看";
        by_id("chat-meta").textContent = "选择会话，查看已保留的消息";
        show_empty(state.query ? "没有找到匹配的记录" : "暂无撤回记录", state.query
            ? "试试会话名、群号、发送者或消息中的关键词" : "已保存的历史记录和之后拦截的撤回消息会显示在这里");
        by_id("result-count").textContent = "0 条记录";
        return;
    }
    by_id("chat-title").textContent = conversation.title;
    by_id("chat-meta").textContent = `${conversation.chat_type === 2 ? "群聊" : "会话"} · ${conversation.peer_number} · ${conversation.count} 条${state.query ? "匹配" : "撤回"}记录`;
    const timeline = by_id("timeline");
    const previous_height = timeline.scrollHeight;
    const previous_top = timeline.scrollTop;
    const result = await request(api.messages({ conversation_id: state.selected, query: state.query, offset: older ? state.next : 0, limit: 50 }));
    if (revision !== state.revision) return;
    state.records = older ? [...result.records, ...state.records] : result.records;
    state.next = result.next_offset;
    by_id("empty").hidden = state.records.length > 0;
    by_id("load-more").hidden = state.next === null;
    by_id("result-count").textContent = `已显示 ${state.records.length} / ${result.total} 条记录`;
    render_messages();
    if (older) timeline.scrollTop = previous_top + timeline.scrollHeight - previous_height;
    else timeline.scrollTop = timeline.scrollHeight;
}

async function refresh(force = false) {
    const search = state.query;
    by_id("refresh").disabled = true;
    try {
        const result = await request(api.list({ query: search, refresh: force }));
        if (search !== state.query) return;
        state.conversations = result.conversations;
        if (!state.conversations.some(item => item.id === state.selected)) state.selected = state.conversations[0]?.id || null;
        by_id("totals").textContent = `${result.total} 条记录 · ${result.conversations.length} 个${search ? "匹配" : ""}会话`;
        by_id("storage").textContent = result.saved ? "已启用重启后保存" : "未启用新消息持久保存";
        by_id("warning").hidden = !result.warning;
        by_id("warning").textContent = result.warning || "";
        render_conversations();
        await load_messages();
    } catch (error) {
        by_id("warning").hidden = false; by_id("warning").textContent = error.message;
        if (!state.records.length) show_empty("暂时无法读取记录", "点击左下角“刷新记录”重试");
    } finally { by_id("refresh").disabled = false; }
}

by_id("search").addEventListener("input", () => {
    clearTimeout(search_timer);
    state.query = by_id("search").value.trim();
    state.revision++;
    search_timer = setTimeout(() => { void refresh(); }, 180);
});
by_id("refresh").addEventListener("click", () => { void refresh(true); });
by_id("load-more").addEventListener("click", async () => {
    by_id("load-more").disabled = true;
    try { await load_messages(true); } catch (error) { notify(error.message); }
    finally { by_id("load-more").disabled = false; }
});
by_id("close-preview").addEventListener("click", () => by_id("image-preview").close());
by_id("image-preview").addEventListener("close", () => { preview_revision++; by_id("full-image").removeAttribute("src"); });
api.changed(() => {
    const timeline = by_id("timeline");
    if (timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight > 120 && state.records.length) {
        notify("有新撤回记录，点击左下角“刷新记录”查看");
    } else { clearTimeout(search_timer); search_timer = setTimeout(() => { void refresh(); }, 200); }
});
void refresh();
