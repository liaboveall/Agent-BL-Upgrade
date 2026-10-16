// Translation strings may carry <strong>, <em> and &amp;. They are parsed into React elements here,
// before interpolation, so a {variable} (which can hold server data) is always plain text.
import { Fragment } from 'react';
import { t } from '../lib/i18n.js';

const TOKEN = /(<strong>|<\/strong>|<em>|<\/em>|\{\w+\})/u;

export function richText(template, vars = {}) {
  const parts = String(template).split(TOKEN).filter((part) => part !== '');
  const root = { tag: null, children: [] };
  const stack = [root];
  for (const part of parts) {
    const top = stack.at(-1);
    if (part === '<strong>' || part === '<em>') {
      const node = { tag: part.slice(1, -1), children: [] };
      top.children.push(node);
      stack.push(node);
    } else if (part === '</strong>' || part === '</em>') {
      if (stack.length > 1) stack.pop();
    } else if (/^\{\w+\}$/u.test(part)) {
      const value = vars[part.slice(1, -1)];
      top.children.push(value == null ? '' : String(value));
    } else {
      top.children.push(part.replaceAll('&amp;', '&'));
    }
  }
  const render = (node, key) => {
    if (typeof node === 'string') return <Fragment key={key}>{node}</Fragment>;
    const Tag = node.tag;
    return <Tag key={key}>{node.children.map(render)}</Tag>;
  };
  return root.children.map(render);
}

export function RichT({ k, vars }) {
  return <>{richText(t(k), vars)}</>;
}
