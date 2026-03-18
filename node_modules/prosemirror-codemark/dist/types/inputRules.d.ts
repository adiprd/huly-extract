import { Plugin } from 'prosemirror-state';
import type { Transaction } from 'prosemirror-state';
import type { Options } from './types';
declare type InputRuleState = {
    transform: Transaction;
    from: number;
    to: number;
    text: string;
} | null;
export declare function createInputRule(cursorPlugin: Plugin, opts?: Options): Plugin<InputRuleState>;
export {};
