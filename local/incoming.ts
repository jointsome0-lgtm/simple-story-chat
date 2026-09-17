import { UserError } from '../lib/library.ts';
import { member } from './model-error.ts';

// Bot API JSON is not validated in advance: rich message nodes are read as objects with
// unknown fields, and the walk below checks what it relies on.
export type IncomingMessage = { text?: unknown; rich_message?: { blocks?: unknown } };
type Node = { readonly [field: string]: unknown };
// List entries and table cells are not checked to be objects; a malformed one fails with a TypeError.
type ListEntry = { has_checkbox?: unknown; is_checked?: unknown; label?: unknown; blocks?: unknown };
type TableCell = { colspan?: number; rowspan?: number; text?: unknown } | null | undefined;

const isNode = (value: unknown): value is Node => !!value && typeof value === 'object';

// RichMessage has a block tree, not a `text` field. Preserve the textual
// structure (including tables and collapsed details); never save a partial seed
// after silently skipping an unsupported attachment or block.
export function messageText(message: IncomingMessage | null | undefined): string {
  if (!message?.rich_message) return typeof message?.text === 'string' ? message.text.trim() : '';
  let visited = 0;
  const unsupported: () => never = () => { throw new UserError('В сообщении есть неподдерживаемое содержимое. Пришли сид или продолжение текстом без вложений. Ничего не сохранено.'); };
  const visit = (depth: number) => { if (++visited > 20000 || depth > 48) unsupported(); };
  const list = (value: unknown): unknown[] => { if (!Array.isArray(value)) unsupported(); return value; };
  const text = (value: unknown, depth = 0): string => {
    visit(depth);
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(v => text(v, depth + 1)).join('');
    if (!isNode(value)) return unsupported();
    if (value.type === 'custom_emoji') return String(value.alternative_text || '');
    if (value.type === 'mathematical_expression') return String(value.expression || '');
    if (value.type === 'anchor') return '';
    const styles: Record<string, string> = { bold: '**', italic: '*', underline: '__', strikethrough: '~~', spoiler: '||', marked: '==' };
    // Property keys are strings anyway; String() only makes that conversion explicit.
    if (Object.hasOwn(styles, String(value.type))) {
      const mark = styles[String(value.type)];
      return mark + text(value.text, depth + 1) + mark;
    }
    if (value.type === 'url') return `${text(value.text, depth + 1)} (${String(value.url || '')})`;
    const wrappers = ['date_time', 'text_mention', 'subscript', 'superscript', 'code', 'email_address',
      'phone_number', 'bank_card_number', 'mention', 'hashtag', 'cashtag', 'bot_command',
      'anchor_link', 'reference', 'reference_link'] as const;
    if (member(wrappers, value.type)) return text(value.text, depth + 1);
    return unsupported();
  };
  const blocks = (items: unknown, depth = 0): string => {
    visit(depth);
    return list(items).map(item => {
      visit(depth + 1);
      if (!isNode(item)) return unsupported();
      if (member(['paragraph', 'heading', 'pre', 'footer'], item.type)) return text(item.text, depth + 2);
      if (item.type === 'divider') return '---';
      if (item.type === 'anchor') return '';
      if (item.type === 'mathematical_expression') return String(item.expression || '');
      if (member(['blockquote', 'expandable_blockquote', 'pullquote'], item.type)) {
        const body = item.type === 'blockquote' ? blocks(item.blocks, depth + 2) : text(item.text, depth + 2);
        return (body + (item.credit ? '\n' + text(item.credit, depth + 2) : '')).split('\n').map(line => '> ' + line).join('\n');
      }
      if (item.type === 'details') return text(item.summary, depth + 2) + '\n\n' + blocks(item.blocks, depth + 2);
      if (item.type === 'list') return (list(item.items) as ListEntry[]).map(entry => {
        const mark = entry.has_checkbox ? (entry.is_checked ? '[x]' : '[ ]') : entry.label || '•';
        return `${mark} ${blocks(entry.blocks, depth + 2)}`;
      }).join('\n');
      if (item.type === 'table') {
        const rows = list(item.cells).map(row => (list(row) as TableCell[]).map(cell => {
          if (!cell || (cell.colspan ?? 1) > 1 || (cell.rowspan ?? 1) > 1) return unsupported();
          return cell.text === undefined ? '' : text(cell.text, depth + 2);
        }).join('\t')).join('\n');
        return (item.caption ? text(item.caption, depth + 2) + '\n' : '') + rows;
      }
      return unsupported();
    }).filter(Boolean).join('\n\n');
  };
  const result = blocks(message.rich_message.blocks).trim();
  if (Buffer.byteLength(result, 'utf8') > 256 * 1024) unsupported();
  return result;
}

export function seedInput(text: string) {
  const lines = text.trim().split('\n');
  const plainHeader = (line: string) => line.replace(/^[#*_\s]+|[*_\s]+$/g, '');
  const title = plainHeader(lines.shift() || '');
  while (lines.length && !lines[0].trim()) lines.shift();
  const date = plainHeader(lines.shift() || '');
  return [title, date, ...lines].join('\n');
}
