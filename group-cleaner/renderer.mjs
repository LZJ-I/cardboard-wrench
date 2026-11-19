// 每个面板实例拥有自己的选择、筛选和滚动位置；群名等外部数据只写入 textContent。
const base_url = new URL(".", import.meta.url);
const resources = Promise.all([
    fetch(new URL("ui/panel.html", base_url)).then(response => response.text()),
    fetch(new URL("ui/style.css", base_url)).then(response => response.text())
]);
let popup;

async function call_api(name, ...args) {
    if (!window.group_cleaner) throw new Error("插件桥接尚未就绪，请完全退出 QQ 后重新启动");
    const result = await window.group_cleaner[name](...args);
    if (!result?.ok) throw new Error(result?.error || "QQ 未返回有效结果");
    return result.data;
}

class GroupPanel {
    constructor(host, html, css) {
        this.root = host.attachShadow({ mode: "open" });
        const style = document.createElement("style");
        style.textContent = css;
        this.root.append(style);
        const template = document.createElement("template");
        template.innerHTML = html;
        this.root.append(template.content.cloneNode(true));
        this.groups = [];
        this.selected = new Set();
        this.rows = new Map();
        this.account = "";
        this.job = null;
        this.pending = false;
        this.loaded = false;
        this.calibration = { ready: false, active: false, message: "请先校准一次 QQ 原生退群操作。" };
        this.list = this.root.querySelector('[data-part="list"]');
        this.root.addEventListener("input", event => {
            if (["search", "filter", "sort"].includes(event.target.dataset.input)) this.render();
        });
        this.root.addEventListener("change", event => this.on_change(event));
        this.root.addEventListener("click", event => this.on_click(event));
        this.unsubscribe = window.group_cleaner?.on_progress(job => {
            if (job && job.account !== this.account) return;
            if (job) {
                const completed_ids = new Set(job.items.filter(item => item.status === "success").map(item => item.id));
                this.groups = this.groups.filter(group => !completed_ids.has(group.id));
                for (const id of completed_ids) this.selected.delete(id);
            }
            this.job = job;
            this.apply_progress();
        });
        this.unsubscribe_account = window.group_cleaner?.on_account_changed?.(() => {
            this.groups = []; this.selected.clear(); this.account = ""; this.loaded = false; this.job = null;
            this.notice("QQ 账号状态已变化，请刷新群列表。");
            this.apply_progress();
        });
        this.unsubscribe_calibration = window.group_cleaner?.on_calibration?.(state => {
            this.calibration = state;
            this.notice(state.message, !state.ready && !state.active);
            this.render();
        });
        this.load_state();
    }

    input(name) { return this.root.querySelector(`[data-input="${name}"]`); }
    action(name) { return this.root.querySelector(`[data-action="${name}"]`); }
    stat(name, text) { this.root.querySelector(`[data-stat="${name}"]`).textContent = text; }
    is_busy() { return this.pending || Boolean(this.job?.running); }
    eligible(group) { return !group.retained && !group.owner && group.role_known; }

    notice(text, error = false) {
        const notice = this.root.querySelector('[data-part="notice"]');
        notice.textContent = text;
        notice.classList.toggle("error", error);
    }

    set_state(state) {
        if (state.account !== this.account) this.selected.clear();
        this.account = state.account;
        this.groups = state.groups;
        this.job = state.job;
        if (state.calibration) this.calibration = state.calibration;
        this.loaded = Boolean(state.updated_at);
        const available = new Set(this.groups.filter(group => this.eligible(group)).map(group => group.id));
        for (const id of this.selected) if (!available.has(id)) this.selected.delete(id);
        this.apply_progress();
    }

    async load_state() {
        try {
            const state = await call_api("state");
            this.set_state(state);
            if (!this.calibration.ready || this.calibration.active) this.notice(this.calibration.message);
            else if (state.updated_at) this.notice("群列表已就绪。选择群聊后，一次确认名单即可退出。");
        } catch (error) { this.notice(error.message, true); }
    }

    filtered_groups() {
        const search = this.input("search").value.trim().toLocaleLowerCase();
        const filter = this.input("filter").value;
        return this.groups.filter(group => {
            if (search && !`${group.name} ${group.remark} ${group.id}`.toLocaleLowerCase().includes(search)) return false;
            if (filter === "eligible" && !this.eligible(group)) return false;
            if (filter === "retained" && !group.retained) return false;
            if (filter === "owner" && !group.owner) return false;
            return true;
        }).sort((a, b) => this.input("sort").value === "members" ?
            b.members - a.members || a.name.localeCompare(b.name, "zh-CN") : a.name.localeCompare(b.name, "zh-CN"));
    }

    create_row(group) {
        const row = document.createElement("div");
        row.className = "group-row";
        row.dataset.id = group.id;
        row.setAttribute("role", "row");
        const check = document.createElement("input");
        check.type = "checkbox";
        check.dataset.input = "group";
        check.setAttribute("aria-label", `选择 ${group.name}`);
        const info = document.createElement("div");
        const name = document.createElement("button");
        name.type = "button";
        name.className = "group-name";
        name.dataset.action = "open-group";
        name.title = "点击打开群聊";
        const meta = document.createElement("div"); meta.className = "group-meta";
        info.append(name, meta);
        const actions = document.createElement("div"); actions.className = "row-actions";
        for (const [action, label, class_name] of [["retain", "保留", "retain"], ["leave-one", "退群", "leave-one"]]) {
            const button = document.createElement("button");
            button.dataset.action = action;
            button.className = class_name;
            button.textContent = label;
            actions.append(button);
        }
        row.append(check, info, actions);
        return row;
    }

    render() {
        const scroll_top = this.list.scrollTop;
        const list_top = this.list.getBoundingClientRect().top;
        const anchor = [...this.list.children].find(row => row.classList.contains("group-row") && row.getBoundingClientRect().bottom > list_top);
        const anchor_id = anchor?.dataset.id;
        const anchor_offset = anchor ? anchor.getBoundingClientRect().top - list_top : 0;
        const visible = this.filtered_groups();
        const visible_ids = new Set(visible.map(group => group.id));
        for (const row of this.rows.values()) if (!visible_ids.has(row.dataset.id)) row.remove();
        this.list.querySelector(".empty")?.remove();
        let previous = null;
        for (const group of visible) {
            let row = this.rows.get(group.id);
            if (!row) { row = this.create_row(group); this.rows.set(group.id, row); }
            const expected = previous ? previous.nextElementSibling : this.list.firstElementChild;
            if (row !== expected) this.list.insertBefore(row, expected);
            previous = row;
            row.querySelector(".group-name").textContent = group.name;
            row.querySelector(".group-name").disabled = this.is_busy();
            row.querySelector(".group-name").setAttribute("aria-label", `打开群聊 ${group.name}`);
            const labels = [group.id, group.members ? `${group.members} 人` : "", group.remark && group.remark !== group.name ? `备注：${group.remark}` : ""];
            if (group.owner) labels.push("群主 · 已保护");
            else if (!group.role_known) labels.push("身份待确认");
            else if (group.role === "admin") labels.push("管理员");
            const progress = this.job?.items.find(item => item.id === group.id);
            if (progress) labels.push(progress.message);
            row.querySelector(".group-meta").textContent = labels.filter(Boolean).join(" · ");
            const check = row.querySelector('input[type="checkbox"]');
            check.setAttribute("aria-label", `选择 ${group.name}`);
            check.checked = this.selected.has(group.id);
            check.disabled = this.is_busy() || !this.eligible(group);
            row.classList.toggle("locked", !this.eligible(group));
            row.classList.toggle("selected", check.checked);
            const retain = row.querySelector('[data-action="retain"]');
            retain.textContent = group.retained ? "已保留" : "保留";
            retain.classList.toggle("active", group.retained);
            retain.setAttribute("aria-pressed", String(group.retained));
            retain.disabled = this.is_busy();
            row.querySelector('[data-action="leave-one"]').disabled = this.is_busy() || !this.eligible(group) || !this.calibration.ready || this.calibration.active;
        }
        if (!visible.length) {
            const empty = document.createElement("div"); empty.className = "empty";
            empty.textContent = this.loaded ? "没有符合当前条件的群聊" : "点右上角“刷新群列表”开始整理";
            this.list.append(empty);
        }
        const new_anchor = this.rows.get(anchor_id);
        if (new_anchor?.isConnected) this.list.scrollTop += new_anchor.getBoundingClientRect().top - list_top - anchor_offset;
        else this.list.scrollTop = scroll_top;
        this.stat("total", this.loaded ? `共 ${this.groups.length} 个群` : "尚未读取群列表");
        this.stat("retained", `保留 ${this.groups.filter(group => group.retained).length} 个`);
        this.stat("selected", `已选 ${this.selected.size} 个`);
        this.stat("visible", `当前显示 ${visible.length} 个`);
        const eligible = visible.filter(group => this.eligible(group));
        const selected_visible = eligible.filter(group => this.selected.has(group.id)).length;
        this.input("select-all").checked = eligible.length > 0 && selected_visible === eligible.length;
        this.input("select-all").indeterminate = selected_visible > 0 && selected_visible < eligible.length;
        this.input("select-all").disabled = this.is_busy() || !eligible.length;
        for (const action of ["refresh", "clear"]) this.action(action).disabled = this.is_busy();
        this.action("leave").disabled = this.is_busy() || !this.selected.size || !this.calibration.ready || this.calibration.active;
        this.action("leave").textContent = `退出所选群（${this.selected.size}）`;
        this.action("stop").hidden = !this.job?.running;
        this.action("stop").disabled = Boolean(this.job?.stop_requested);
        this.action("calibrate").disabled = this.is_busy() || this.calibration.active;
        this.action("calibrate").textContent = this.calibration.ready ? "重新校准退群" : "开始校准退群";
        this.action("cancel-calibration").hidden = !this.calibration.active;
        this.root.querySelector('[data-part="calibration-status"]').textContent = this.calibration.message;
    }

    apply_progress() {
        if (this.job) {
            const completed_ids = new Set(this.job.items.filter(item => item.status === "success").map(item => item.id));
            const success = completed_ids.size;
            const progress = this.root.querySelector('[data-part="progress"]');
            const failures = this.job.items.filter(item => item.status === "failed").length;
            progress.textContent = this.job.running ? `执行中 ${this.job.completed}/${this.job.total} · 已退出 ${success} 个` :
                `执行结束 · 已退出 ${success} 个 · 失败 ${failures} 个 · 其余 ${this.job.total - success - failures} 个`;
            const result_list = this.root.querySelector('[data-part="result-list"]');
            result_list.replaceChildren(...this.job.items.map(item => {
                const li = document.createElement("li"); li.textContent = `${item.name}（${item.id}）：${item.message}`; return li;
            }));
            this.root.querySelector('[data-part="results"]').hidden = false;
            if (!this.job.running) {
                const failure = this.job.items.find(item => item.status === "failed" || item.status === "unknown");
                this.notice(failure ? `${failure.name}：${failure.message}` : "执行已结束。列表位置已保留。", Boolean(failure));
                if (failure) this.root.querySelector('[data-part="results"]').open = true;
            }
        } else {
            this.root.querySelector('[data-part="progress"]').textContent = "请选择要退出的群聊";
            this.root.querySelector('[data-part="results"]').hidden = true;
            this.root.querySelector('[data-part="result-list"]').replaceChildren();
        }
        this.render();
    }

    on_change(event) {
        if (this.is_busy()) return;
        if (event.target.dataset.input === "group") {
            const id = event.target.closest(".group-row").dataset.id;
            event.target.checked ? this.selected.add(id) : this.selected.delete(id);
        } else if (event.target.dataset.input === "select-all") {
            for (const group of this.filtered_groups().filter(group => this.eligible(group))) {
                event.target.checked ? this.selected.add(group.id) : this.selected.delete(group.id);
            }
        } else return;
        if (this.selected.size > 200) {
            this.selected = new Set([...this.selected].slice(0, 200));
            this.notice("每批最多选择 200 个群，已保留前 200 个选择。");
        }
        this.render();
    }

    async on_click(event) {
        const button = event.target.closest("button[data-action]");
        if (!button || button.disabled) return;
        const action = button.dataset.action;
        if (action === "cancel-calibration") {
            try { this.calibration = await call_api("cancel_calibration"); this.notice(this.calibration.message); this.render(); }
            catch (error) { this.notice(error.message, true); }
            return;
        }
        if (action === "clear") { this.selected.clear(); this.render(); return; }
        if (action === "stop") {
            try { await call_api("stop"); this.notice("已请求停止。正在等待当前请求结束，不会再退出下一个群。"); }
            catch (error) { this.notice(error.message, true); }
            return;
        }
        if (this.is_busy()) return;
        this.pending = true; this.render();
        try {
            if (action === "refresh") {
                this.notice("正在读取 QQ 群列表…");
                this.set_state(await call_api("refresh"));
                this.notice(this.calibration.ready ? "群列表已刷新。保留标记会按当前 QQ 账号保存。" : this.calibration.message);
            } else if (action === "calibrate") {
                this.set_state(await call_api("calibrate"));
                this.notice(this.calibration.message);
                if (popup?.panel === this && popup.dialog.open) popup.dialog.close();
            } else if (action === "retain") {
                const id = button.closest(".group-row").dataset.id;
                const group = this.groups.find(group => group.id === id);
                const state = await call_api("retain", id, !group.retained);
                this.groups = state.groups;
                this.selected.delete(id);
                this.notice(group.retained ? "已取消保留。" : "已加入保留名单，单群和批量退群都会跳过它。");
            } else if (action === "open-group") {
                const id = button.closest(".group-row").dataset.id;
                const group = this.groups.find(group => group.id === id);
                await call_api("open_group", id);
                this.notice(`已请求打开“${group.name}”。返回面板后可继续从原位置整理。`);
                if (popup?.panel === this && popup.dialog.open) popup.dialog.close();
            } else if (["leave", "leave-one"].includes(action)) {
                const ids = action === "leave-one" ? [button.closest(".group-row").dataset.id] : [...this.selected];
                this.notice("正在复核所选群聊…");
                const plan = await call_api("prepare", ids);
                const started = await call_api("start", plan.token);
                if (started.cancelled) this.notice("已取消，没有发送退群请求。");
                else {
                    this.set_state(await call_api("state"));
                    this.apply_progress();
                }
            }
        } catch (error) { this.notice(error.message, true); }
        finally { this.pending = false; this.render(); }
    }

    dispose() { this.unsubscribe?.(); this.unsubscribe_calibration?.(); this.unsubscribe_account?.(); }
}

export async function onSettingWindowCreated(view) {
    try {
        const [html, css] = await resources;
        const host = document.createElement("div");
        view.append(host);
        new GroupPanel(host, html, css);
    } catch (error) { view.textContent = `群清理助手加载失败：${error.message}`; }
}

async function toggle_popup() {
    if (popup?.dialog.open) { popup.dialog.close(); return; }
    if (popup) { popup.dialog.showModal(); return; }
    const [html, css] = await resources;
    const dialog = document.createElement("dialog");
    dialog.style.cssText = "width:min(1120px,94vw);max-height:94vh;padding:0;border:1px solid #737b8b;border-radius:14px;background:var(--bg_bottom_standard,#202630);color:inherit;overflow:auto;";
    const close = document.createElement("button");
    close.textContent = "关闭面板";
    close.style.cssText = "position:sticky;display:block;top:8px;margin:8px 12px 0 auto;z-index:1;padding:5px 12px;border-radius:6px;cursor:pointer;";
    close.addEventListener("click", () => dialog.close());
    const host = document.createElement("div");
    dialog.append(close, host);
    document.body.append(dialog);
    popup = { dialog, panel: new GroupPanel(host, html, css) };
    dialog.showModal();
}

document.addEventListener("keydown", event => {
    if (!location.hash.startsWith("#/main") || event.repeat || !event.ctrlKey || !event.shiftKey || event.altKey || event.code !== "KeyG") return;
    event.preventDefault();
    toggle_popup().catch(error => console.warn("[群清理助手]", error.message));
});
