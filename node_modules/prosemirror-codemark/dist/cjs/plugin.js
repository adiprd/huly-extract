"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.codemark = exports.getDecorationPlugin = void 0;
const prosemirror_state_1 = require("prosemirror-state");
const prosemirror_view_1 = require("prosemirror-view");
const utils_1 = require("./utils");
const inputRules_1 = require("./inputRules");
const actions_1 = require("./actions");
function toDom() {
    const span = document.createElement('span');
    span.classList.add('fake-cursor');
    return span;
}
function getDecorationPlugin(opts) {
    const plugin = new prosemirror_state_1.Plugin({
        key: utils_1.pluginKey,
        appendTransaction: (trs, oldState, newState) => {
            var _a;
            const prev = plugin.getState(oldState);
            const meta = (_a = trs[0]) === null || _a === void 0 ? void 0 : _a.getMeta(plugin);
            if ((prev === null || prev === void 0 ? void 0 : prev.next) || (meta === null || meta === void 0 ? void 0 : meta.action) === 'click') {
                return (0, actions_1.stepOutside)(newState, (0, utils_1.getMarkType)(newState, opts));
            }
            return null;
        },
        state: {
            init: () => null,
            apply(tr, value, oldState, state) {
                var _a;
                const meta = tr.getMeta(plugin);
                if ((meta === null || meta === void 0 ? void 0 : meta.action) === 'next')
                    return { next: true };
                const markType = (0, utils_1.getMarkType)(state, opts);
                const nextMark = markType.isInSet((_a = state.storedMarks) !== null && _a !== void 0 ? _a : state.doc.resolve(tr.selection.from).marks());
                const inCode = markType.isInSet(state.doc.resolve(tr.selection.from).marks());
                const nextCode = markType.isInSet((0, utils_1.safeResolve)(state.doc, tr.selection.from + 1).marks());
                const startOfLine = tr.selection.$from.parentOffset === 0;
                if (!tr.selection.empty)
                    return null;
                if (!nextMark && nextCode && (!inCode || startOfLine)) {
                    // |`code`
                    return { active: true, side: -1 };
                }
                if (nextMark && (!inCode || startOfLine)) {
                    // `|code`
                    return { active: true, side: 0 };
                }
                if (!nextMark && inCode && !nextCode) {
                    // `code`|
                    return { active: true, side: 0 };
                }
                if (nextMark && inCode && !nextCode) {
                    // `code|`
                    return { active: true, side: -1 };
                }
                return null;
            },
        },
        props: {
            attributes: (state) => {
                var _a;
                const { active = false } = (_a = plugin.getState(state)) !== null && _a !== void 0 ? _a : {};
                return Object.assign({}, (active ? { class: 'no-cursor' } : {}));
            },
            decorations: (state) => {
                var _a;
                const { active, side } = (_a = plugin.getState(state)) !== null && _a !== void 0 ? _a : {};
                if (!active)
                    return prosemirror_view_1.DecorationSet.empty;
                const deco = prosemirror_view_1.Decoration.widget(state.selection.from, toDom, { side });
                return prosemirror_view_1.DecorationSet.create(state.doc, [deco]);
            },
            handleKeyDown(view, event) {
                switch (event.key) {
                    case '`':
                        return (0, actions_1.onBacktick)(view, plugin, event, (0, utils_1.getMarkType)(view, opts));
                    case 'ArrowRight':
                        return (0, actions_1.onArrowRight)(view, plugin, event, (0, utils_1.getMarkType)(view, opts));
                    case 'ArrowLeft':
                        return (0, actions_1.onArrowLeft)(view, plugin, event, (0, utils_1.getMarkType)(view, opts));
                    case 'Backspace':
                        return (0, actions_1.onBackspace)(view, plugin, event, (0, utils_1.getMarkType)(view, opts));
                    case 'Delete':
                        return (0, actions_1.onDelete)(view, plugin, event, (0, utils_1.getMarkType)(view, opts));
                    case 'ArrowUp':
                    case 'ArrowDown':
                    case 'Home':
                    case 'End':
                        return (0, actions_1.stepOutsideNextTrAndPass)(view, plugin);
                    case 'e':
                    case 'a':
                        if (!event.ctrlKey)
                            return false;
                        return (0, actions_1.stepOutsideNextTrAndPass)(view, plugin);
                    default:
                        return false;
                }
            },
            handleClick(view) {
                return (0, actions_1.stepOutsideNextTrAndPass)(view, plugin, 'click');
            },
        },
    });
    return plugin;
}
exports.getDecorationPlugin = getDecorationPlugin;
function codemark(opts) {
    const cursorPlugin = getDecorationPlugin(opts);
    const inputRule = (0, inputRules_1.createInputRule)(cursorPlugin, opts);
    const rules = [cursorPlugin, inputRule];
    return rules;
}
exports.codemark = codemark;
//# sourceMappingURL=plugin.js.map