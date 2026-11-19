"use strict";

// 来源：本机 QQ 9.9.37-54395 已成功的原生退群校准，参数不含用户数据。
function default_template(qq_version) {
    if (qq_version !== "9.9.37-54395") return null;
    return {
        event_name: "ntApi", command: "nodeIKernelGroupService/quitGroup", cmd_type: "invoke",
        payload: [{ groupCode: { $group_cleaner_target: "string" } }, { $group_cleaner_value: "undefined" }]
    };
}

module.exports = { default_template };
