import { UserError } from '../lib/library.js';

// RichMessage has a block tree, not a `text` field. Preserve the textual
// structure (including tables and collapsed details); never save a partial seed
// after silently skipping an unsupported attachment or block.
export function messageText(message) {
  if (!message?.rich_message) return typeof message?.text === 'string' ? message.text.trim() : '';
  let visited = 0;
  const unsupported = () => { throw new UserError('В сообщении есть неподдерживаемое содержимое. Пришли сид или продолжение текстом без вложений. Ничего не сохранено.'); };
  const visit = depth => { if (++visited > 20000 || depth > 48) unsupported(); };
  const list = value => { if (!Array.isArray(value)) unsupported(); return value; };
  const text = (value, depth = 0) => {
    visit(depth);
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(v => text(v, depth + 1)).join('');
    if (!value || typeof value !== 'object') return unsupported();
    if (value.type === 'custom_emoji') return String(value.alternative_text || '');
    if (value.type === 'mathematical_expression') return String(value.expression || '');
    if (value.type === 'anchor') return '';
    const styles = { bold: '**', italic: '*', underline: '__', strikethrough: '~~', spoiler: '||', marked: '==' };
    if (Object.hasOwn(styles, value.type)) {
      const mark = styles[value.type];
      return mark + text(value.text, depth + 1) + mark;
    }
    if (value.type === 'url') return `${text(value.text, depth + 1)} (${String(value.url || '')})`;
    const wrappers = ['date_time', 'text_mention', 'subscript', 'superscript', 'code', 'email_address',
      'phone_number', 'bank_card_number', 'mention', 'hashtag', 'cashtag', 'bot_command',
      'anchor_link', 'reference', 'reference_link'];
    if (wrappers.includes(value.type)) return text(value.text, depth + 1);
    return unsupported();
  };
  const blocks = (items, depth = 0) => {
    visit(depth);
    return list(items).map(item => {
      visit(depth + 1);
      if (!item || typeof item !== 'object') return unsupported();
      if (['paragraph', 'heading', 'pre', 'footer'].includes(item.type)) return text(item.text, depth + 2);
      if (item.type === 'divider') return '---';
      if (item.type === 'anchor') return '';
      if (item.type === 'mathematical_expression') return String(item.expression || '');
      if (['blockquote', 'expandable_blockquote', 'pullquote'].includes(item.type)) {
        const body = item.type === 'blockquote' ? blocks(item.blocks, depth + 2) : text(item.text, depth + 2);
        return (body + (item.credit ? '\n' + text(item.credit, depth + 2) : '')).split('\n').map(line => '> ' + line).join('\n');
      }
      if (item.type === 'details') return text(item.summary, depth + 2) + '\n\n' + blocks(item.blocks, depth + 2);
      if (item.type === 'list') return list(item.items).map(entry => {
        const mark = entry.has_checkbox ? (entry.is_checked ? '[x]' : '[ ]') : entry.label || '•';
        return `${mark} ${blocks(entry.blocks, depth + 2)}`;
      }).join('\n');
      if (item.type === 'table') {
        const rows = list(item.cells).map(row => list(row).map(cell => {
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

export function seedInput(text) {
  const lines = text.trim().split('\n');
  const plainHeader = line => line.replace(/^[#*_\s]+|[*_\s]+$/g, '');
  const title = plainHeader(lines.shift() || '');
  while (lines.length && !lines[0].trim()) lines.shift();
  const date = plainHeader(lines.shift() || '');
  return [title, date, ...lines].join('\n');
}
