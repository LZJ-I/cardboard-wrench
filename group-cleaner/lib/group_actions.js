"use strict";

const { valid_group_id } = require("./group_model.js");

// 只组装已限定的退群和打开会话操作，不暴露任意原生调用。
function open_group_script(group_id) {
    if (!valid_group_id(group_id)) throw new Error("无效群号");
    return `(() => {
        const channel = new BroadcastChannel('MainWindow');
        channel.postMessage({
            promiseId: crypto.randomUUID(), sender: 'MsgRecordWindow',
            type: 'req', postMessageType: 'invoke', eventName: 'invoke',
            params: { moduleName: 'mainPage', cmdName: 'jumpNewAio',
                args: [{ peerUid: ${JSON.stringify(group_id)}, chatType: 2, type: 1, params: {} }]
            }
        });
        channel.close();
        return true;
    })()`;
}

async function open_group(transport, browser_window, group_id) {
    const source = open_group_script(group_id);
    const peer = transport.find_peer();
    await peer.executeJavaScript(source, true);
    const window = browser_window.fromWebContents(peer);
    if (window && !window.isDestroyed()) {
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
        peer.focus();
    }
    return { opened: true };
}

module.exports = { open_group_script, open_group };
