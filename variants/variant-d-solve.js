// Variant D — fully inlined state machine (no helper closures in the hot path, so
// pos/line stay stack locals). Same semantics as variant B: per-field indexOf scans
// for unquoted fields, indexOf('"') jumps for quoted fields.
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const n = text.length;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;

    const recLine = line;
    const recRow = header && columns === null ? null : rows.length;
    const fields = [];
    let ended = 0;
    let quoted = false;
    do {
      let value = '';
      let junkBase = -1;
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        const open = pos;
        const openLine = line;
        let k = text.indexOf('"', pos + 1);
        let closed = -1;
        let doubled = false;
        while (k !== -1) {
          if (text.charCodeAt(k + 1) === 34) {
            doubled = true;
            k = text.indexOf('"', k + 2);
          } else {
            closed = k;
            break;
          }
        }
        if (closed === -1) {
          // The quote never closes: literal character, text after it read again as unquoted.
          pos = open + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recLine, row: recRow });
          value = '"';
        } else {
          let body = text.slice(open + 1, closed);
          if (doubled) body = body.replaceAll('""', '"');
          if (body.indexOf('\n') !== -1 || body.indexOf('\r') !== -1) {
            body = body.replace(/\r\n?/g, '\n');
            let nl = 0;
            for (let i = 0; i < body.length; i++) if (body.charCodeAt(i) === 10) nl += 1;
            line += nl;
          }
          pos = closed + 1;
          if (pos >= n) {
            fields.push(body);
            ended = 2;
            continue;
          }
          const c = text.charCodeAt(pos);
          if (c === 44) {
            pos += 1;
            fields.push(body);
            ended = 0;
            continue;
          }
          if (c === 10) {
            pos += 1;
            line += 1;
            fields.push(body);
            ended = 1;
            continue;
          }
          if (c === 13 && text.charCodeAt(pos + 1) === 10) {
            pos += 2;
            line += 1;
            fields.push(body);
            ended = 1;
            continue;
          }
          // What follows the closing quote is appended as it stands.
          value = body;
          junkBase = body.length;
        }
      } else {
        quoted = false;
        value = '';
      }
      // Unquoted scan from pos, appending onto value.
      for (;;) {
        const comma = text.indexOf(',', pos);
        const lf = text.indexOf('\n', pos);
        let end;
        let isComma;
        if (comma === -1) {
          if (lf === -1) { end = n; isComma = false; } else { end = lf; isComma = false; }
        } else if (lf === -1) { end = comma; isComma = true; }
        else if (comma < lf) { end = comma; isComma = true; }
        else { end = lf; isComma = false; }
        // A CR immediately before the LF is the CRLF line break, not field content.
        let contentEnd = end;
        if (lf !== -1 && end === lf && end > pos && text.charCodeAt(end - 1) === 13) contentEnd = end - 1;
        const seg = text.slice(pos, contentEnd);
        if (seg.indexOf('\r') === -1) {
          if (value === '') value = seg;
          else value += seg;
          if (end === n) {
            pos = n;
            ended = 2;
          } else if (isComma) {
            pos = end + 1;
            ended = 0;
          } else {
            pos = end + 1;
            line += 1;
            ended = 1;
          }
          break;
        }
        // Slow path: stray CR(s) inside this field; drop each with an error.
        for (let i = pos; i < contentEnd; i++) {
          const ch = text.charCodeAt(i);
          if (ch === 13) {
            errors.push({ code: 'stray_cr', line: recLine, row: recRow });
            continue;
          }
          value += text[i];
        }
        if (end === n) {
          pos = n;
          ended = 2;
        } else if (isComma) {
          pos = end + 1;
          ended = 0;
        } else {
          pos = end + 1;
          line += 1;
          ended = 1;
        }
        break;
      }
      if (junkBase !== -1 && value.length > junkBase) {
        errors.push({ code: 'quote_junk', line: recLine, row: recRow });
      }
      fields.push(value);
    } while (ended === 0);

    // A line that held only stray CRs is left with no characters: no record.
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recLine, row: recRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recLine, row: recRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
