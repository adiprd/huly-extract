import { Plugin } from 'prosemirror-state';
import type { CodemarkState, Options } from './types';
export declare function getDecorationPlugin(opts?: Options): Plugin<CodemarkState>;
export declare function codemark(opts?: Options): Plugin<any>[];
