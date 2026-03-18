"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.safeResolve = exports.getMarkType = exports.pluginKey = exports.MAX_MATCH = exports.DEFAULT_ID = void 0;
const prosemirror_state_1 = require("prosemirror-state");
exports.DEFAULT_ID = 'codemark';
exports.MAX_MATCH = 100;
exports.pluginKey = new prosemirror_state_1.PluginKey(exports.DEFAULT_ID);
function getMarkType(view, opts) {
    var _a, _b;
    if ('schema' in view)
        return (_a = opts === null || opts === void 0 ? void 0 : opts.markType) !== null && _a !== void 0 ? _a : view.schema.marks.code;
    return (_b = opts === null || opts === void 0 ? void 0 : opts.markType) !== null && _b !== void 0 ? _b : view.state.schema.marks.code;
}
exports.getMarkType = getMarkType;
function safeResolve(doc, pos) {
    return doc.resolve(Math.min(Math.max(1, pos), doc.nodeSize - 2));
}
exports.safeResolve = safeResolve;
//# sourceMappingURL=utils.js.map