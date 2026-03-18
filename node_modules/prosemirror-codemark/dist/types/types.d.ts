import type { MarkType } from 'prosemirror-model';
export declare type Options = {
    markType?: MarkType;
};
export declare type CodemarkState = {
    active?: boolean;
    side?: -1 | 0;
    next?: true;
    click?: true;
} | null;
export declare type CursorMetaTr = {
    action: 'next';
} | {
    action: 'click';
};
