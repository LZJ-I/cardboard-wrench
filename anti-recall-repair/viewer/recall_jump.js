"use strict";

// 本模块只组装已保存消息的定位请求，目标由主进程索引给出。
function jump_script(target) {
    if (!target?.peer_uid || !target.msg_id || !Number.isInteger(target.chat_type) || target.chat_type <= 0) {
        throw new Error("消息定位参数不完整");
    }
    const args = { peerUid: String(target.peer_uid), chatType: target.chat_type, type: 1,
        params: { msgId: String(target.msg_id) } };
    // 序列化实际消息身份；消息文本与页面输入不进入可执行代码。
    return `(() => {
        const channel = new BroadcastChannel('MainWindow');
        channel.postMessage({ promiseId: crypto.randomUUID(), sender: 'MsgRecordWindow',
            type: 'req', postMessageType: 'invoke', eventName: 'invoke',
            params: { moduleName: 'mainPage', cmdName: 'jumpNewAio', args: [${JSON.stringify(args)}] }
        });
        channel.close();
        return true;
    })()`;
}

async function jump_message(target, { windows, account_uid = "" }) {
    if (target.account_uid && account_uid && target.account_uid !== account_uid) {
        throw new Error("这条记录属于其它 QQ 账号，请切换到对应账号后定位");
    }
    const candidates = windows.filter(window => !window.isDestroyed() && !window.webContents.isDestroyed() &&
        /#\/main(?:\/|$)/.test(window.webContents.getURL()));
    candidates.sort((a, b) => Number(b.webContents.getURL().includes("#/main/message")) - Number(a.webContents.getURL().includes("#/main/message")));
    const window = candidates[0];
    if (!window) throw new Error("没有找到 QQ 主窗口，请先登录并打开消息页");
    await window.webContents.executeJavaScript(jump_script(target), true);
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    window.webContents.focus();
    return { dispatched: true };
}

module.exports = { jump_script, jump_message };
