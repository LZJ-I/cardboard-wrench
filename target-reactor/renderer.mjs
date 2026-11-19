// 每个设置面板拥有自己的编辑草稿；群名、备注等外部数据只写入 textContent。
const base_url = new URL(".", import.meta.url);
const resources = Promise.all(["ui/panel.html", "ui/style.css"].map(file => fetch(new URL(file, base_url)).then(response => response.text())));

function create_node(tag, class_name, text) {
    const node = document.createElement(tag);
    if (class_name) node.className = class_name;
    if (text !== undefined) node.textContent = text;
    return node;
}

class reactor_panel {
    constructor(view, html, css) {
        this.root = view.attachShadow({ mode: "open" });
        const style = create_node("style", "", css);
        const template = document.createElement("template"); template.innerHTML = html;
        this.root.append(style, template.content.cloneNode(true));
        this.catalog = []; this.config = { enabled: false, rules: [] }; this.state = {}; this.emoji = ""; this.edit_id = ""; this.pending = false;
        this.root.addEventListener("click", event => { const button = event.target.closest("[data-action]"); if (button) void this.action(button); });
        this.input("emoji-search").addEventListener("input", () => this.render_emojis());
        this.input("group").addEventListener("input", () => this.render_recent());
        this.input("enabled").addEventListener("change", () => { void this.save_config({ ...this.config, enabled: this.input("enabled").checked }); });
        this.unsubscribe = window.target_reactor.changed(() => {
            if (view.isConnected) void this.refresh();
            else this.unsubscribe?.();
        });
        void this.refresh(true);
    }
    input(name) { return this.root.querySelector(`[data-input="${name}"]`); }
    part(name) { return this.root.querySelector(`[data-part="${name}"]`); }
    notice(text, error = false) { this.part("notice").textContent = text; this.part("notice").classList.toggle("error", error); }
    async call(name, ...args) {
        const result = await window.target_reactor[name](...args);
        if (!result?.ok) throw new Error(result?.error || "插件未返回结果");
        return result.data;
    }
    async refresh(initial = false) {
        try {
            const state = await this.call("state", initial);
            if (this.state.account && state.account !== this.state.account) this.cancel_edit();
            this.state = state; this.config = state.config;
            if (state.catalog) this.catalog = state.catalog;
            if (!this.emoji) this.emoji = this.catalog.find(item => item.id === "128541")?.id || this.catalog[0]?.id || "";
            this.render_state(); this.render_recent(); this.render_emojis();
            this.notice(!state.account ? "请先登录 QQ，再添加规则。" : this.config.enabled
                ? "自动回应已开启，只处理之后收到的新消息。" : "总开关已关闭：可以先配置规则，开启后才会自动回应。");
        } catch (error) { this.notice(error.message, true); }
    }
    render_state() {
        this.input("enabled").checked = this.config.enabled;
        this.input("enabled").disabled = this.pending || !this.state.account;
        this.root.querySelector('[data-stat="rules"]').textContent = `${this.config.rules.length} 条规则`;
        this.root.querySelector('[data-stat="success"]').textContent = `已回应 ${this.state.stats?.success || 0} 条`;
        this.root.querySelector('[data-stat="queue"]').textContent = `等待 ${this.state.queued || 0} 条`;
        const rules = this.part("rules"); rules.replaceChildren();
        for (const rule of this.config.rules) {
            const emoji = this.catalog.find(item => item.id === rule.emoji_id);
            const error = this.state.errors?.[rule.id];
            const row = create_node("article", "rule"); row.dataset.rule = rule.id;
            const top = create_node("div", "rule-top");
            if (emoji) { const image = create_node("img"); image.src = emoji.src; image.alt = emoji.label; top.append(image); }
            top.append(create_node("span", "rule-name", rule.label || `群 ${rule.group_id}`), create_node("span", "rule-status", error ? "出错暂停" : rule.enabled ? "规则启用" : "规则暂停"));
            row.append(top, create_node("p", "rule-meta", `群 ${rule.group_id} · 成员 ${rule.member_id} · ${emoji?.label || rule.emoji_id}`));
            if (error) row.append(create_node("p", "rule-error", error));
            const actions = create_node("div", "rule-actions");
            for (const [action, label] of [["toggle", error ? "恢复规则" : rule.enabled ? "暂停" : "启用"], ["edit", "编辑"], ["remove", "删除"]]) {
                const button = create_node("button", action === "remove" ? "remove" : "", label);
                button.dataset.action = action; button.dataset.id = rule.id; button.disabled = this.pending; actions.append(button);
            }
            row.append(actions); rules.append(row);
        }
        if (!this.config.rules.length) rules.append(create_node("p", "empty", "还没有规则\n从左侧添加一个群内成员"));
        const events = this.part("events"); events.replaceChildren();
        for (const event of this.state.events || []) {
            const row = create_node("div", "event " + event.outcome);
            row.append(create_node("time", "", new Date(event.at).toLocaleTimeString("zh-CN")), create_node("span", "", `群 ${event.group_id} · ${event.member_id}：${event.message}`));
            events.append(row);
        }
        if (!events.childElementCount) events.append(create_node("p", "empty", "尚未执行自动回应"));
    }
    render_recent() {
        const groups = this.root.querySelector("#reactor-groups"); groups.replaceChildren();
        for (const group of this.state.recent || []) { const option = create_node("option", "", group.name); option.value = group.id; groups.append(option); }
        const members = this.root.querySelector("#reactor-members"); members.replaceChildren();
        const group = this.state.recent?.find(item => item.id === this.input("group").value.trim());
        for (const member of group?.members || []) { const option = create_node("option", "", member.name); option.value = member.id; members.append(option); }
    }
    render_emojis() {
        const list = this.part("emojis"); const top = list.scrollTop;
        list.replaceChildren();
        const query = this.input("emoji-search").value.trim().toLowerCase();
        for (const emoji of this.catalog.filter(item => !query || (item.label + " " + item.id).toLowerCase().includes(query))) {
            const button = create_node("button", "emoji-choice" + (emoji.id === this.emoji ? " selected" : ""));
            button.dataset.action = "emoji"; button.dataset.id = emoji.id; button.title = emoji.label; button.setAttribute("aria-label", emoji.label);
            button.setAttribute("aria-pressed", String(emoji.id === this.emoji));
            const image = create_node("img"); image.src = emoji.src; image.alt = emoji.label; image.loading = "lazy"; button.append(image); list.append(button);
        }
        if (!list.childElementCount) list.append(create_node("p", "empty", "没有匹配的本地表情"));
        list.scrollTop = top;
        const selected = this.catalog.find(item => item.id === this.emoji);
        this.part("chosen").textContent = selected ? `已选：${selected.label}` : "尚未选择";
    }
    async save_config(config) {
        if (this.pending) return false;
        this.pending = true; this.render_state();
        try {
            this.state = { ...this.state, ...await this.call("save", config) }; this.config = this.state.config;
            this.notice(this.config.enabled ? "已保存，之后收到的新消息将按规则回应。" : "已保存；总开关关闭，尚未开始自动回应。");
            return true;
        } catch (error) { this.notice(error.message, true); return false; }
        finally { this.pending = false; this.render_state(); }
    }
    cancel_edit() {
        this.edit_id = ""; this.input("group").value = ""; this.input("member").value = ""; this.input("label").value = "";
        this.part("editor-title").textContent = "添加规则";
        this.root.querySelector('[data-action="save"]').textContent = "添加规则";
        this.root.querySelector('[data-action="cancel"]').hidden = true;
    }
    async action(button) {
        const action = button.dataset.action; const id = button.dataset.id;
        if (action === "emoji") { this.emoji = id; this.render_emojis(); return; }
        if (action === "refresh") { await this.refresh(this.catalog.length === 0); return; }
        if (this.pending) return;
        if (action === "cancel") { this.cancel_edit(); return; }
        const rule = this.config.rules.find(item => item.id === id);
        if (action === "edit" && rule) {
            this.edit_id = id; this.input("group").value = rule.group_id; this.input("member").value = rule.member_id;
            this.input("label").value = rule.label; this.emoji = rule.emoji_id;
            this.part("editor-title").textContent = "编辑规则";
            this.root.querySelector('[data-action="save"]').textContent = "保存修改";
            this.root.querySelector('[data-action="cancel"]').hidden = false;
            this.render_recent(); this.render_emojis(); return;
        }
        if (action === "toggle" && rule) {
            await this.save_config({ ...this.config, rules: this.config.rules.map(item => item.id !== id ? item : { ...item, enabled: this.state.errors?.[id] ? true : !item.enabled }) }); return;
        }
        if (action === "remove" && rule) {
            if (await this.save_config({ ...this.config, rules: this.config.rules.filter(item => item.id !== id) }) && this.edit_id === id) this.cancel_edit(); return;
        }
        if (action === "save") {
            const updated = { id: this.edit_id || crypto.randomUUID(), group_id: this.input("group").value.trim(), member_id: this.input("member").value.trim(),
                emoji_id: this.emoji, label: this.input("label").value.trim(), enabled: this.edit_id ? this.config.rules.find(item => item.id === this.edit_id)?.enabled === true : true };
            const rules = this.config.rules.filter(item => item.id !== this.edit_id); rules.push(updated);
            if (await this.save_config({ ...this.config, rules })) this.cancel_edit();
        }
    }
}

export async function onSettingWindowCreated(view) {
    const [html, css] = await resources;
    new reactor_panel(view, html, css);
}
