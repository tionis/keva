/**
 * @module
 * This module provides Hono's JSX runtime.
 */

export { jsxDEV as jsx, Fragment } from './jsx-dev-runtime.ts'
export { jsxDEV as jsxs } from './jsx-dev-runtime.ts'
export type { JSX } from './jsx-dev-runtime.ts'

import { html, raw } from '../helper/html/index.ts'
import type { HtmlEscapedString } from '../utils/html.ts'
export { html as jsxTemplate }
export const jsxAttr = (
  name: string,
  value: string | Promise<string>
): HtmlEscapedString | Promise<HtmlEscapedString> =>
  typeof value === 'string' ? raw(name + '="' + html`${value}` + '"') : html`${name}="${value}"`
export const jsxEscape = (value: string) => value
