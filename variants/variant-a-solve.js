// Variant A — record-level fast path + per-field indexOf state machine (variant B's core).
// A record whose segment up to the next LF holds no quote and no stray CR is split
// natively (slice + split(',')); anything else falls back to the per-field parser.
// Unquoted fields end at the first of ',' / '\n' found by two native indexOf scans;
// a stray CR inside the sliced field is detected on the short slice and fixed up
// on a rare slow path. Quoted fields jump to the closing quote with indexOf('"').
// Mirrors csv-reader 1.0.0's semantics exactly (see vendor/csv-reader/index.js).
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
  let recLine = 1;
  let recRow = null;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // Field value being read (out-param of readUnq).
  let fld = '';

  // Reads an unquoted field from pos, starting with value v0.
  // Returns 0 = ended at a comma, 1 = ended at a line break, 2 = ended at end of text.
  // Sets fld to the field value. Pushes stray_cr errors as met.
  function readUnq(v0) {
    let value = v0;
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
      // (Only when the delimiter is a real LF; a trailing CR at end of text is stray.)
      let contentEnd = end;
      if (lf !== -1 && end === lf && end > pos && text.charCodeAt(end - 1) === 13) contentEnd = end - 1;
      const seg = text.slice(pos, contentEnd);
      if (seg.indexOf('\r') === -1) {
        value += seg;
        if (end === n) { pos = n; fld = value; return 2; }
        if (isComma) { pos = end + 1; fld = value; return 0; }
        pos = end + 1;
        line += 1;
        fld = value;
        return 1;
      }
      // Slow path: stray CR(s) inside this field; drop each with an error.
      for (let i = pos; i < contentEnd; i++) {
        const c = text.charCodeAt(i);
        if (c === 13) {
          errors.push({ code: 'stray_cr', line: recLine, row: recRow });
          continue;
        }
        value += text[i];
      }
      if (end === n) { pos = n; fld = value; return 2; }
      if (isComma) { pos = end + 1; fld = value; return 0; }
      pos = end + 1;
      line += 1;
      fld = value;
      return 1;
    }
  }

  // Emits one finished record (not the no-record case): width, header, short/long.
  function emit(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recLine, row: recRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recLine, row: recRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;

    recLine = line;
    recRow = header && columns === null ? null : rows.length;
    // Record fast path: no quote and no stray CR in this record's segment.
    {
      const lf = text.indexOf('\n', pos);
      const end = lf === -1 ? n : lf;
      let segEnd = end;
      if (lf !== -1 && end > pos && text.charCodeAt(end - 1) === 13) segEnd = end - 1;
      const seg = text.slice(pos, segEnd);
      if (seg.indexOf('"') === -1 && seg.indexOf('\r') === -1) {
        const fields = seg.split(',');
        emit(fields);
        line += 1;
        pos = lf === -1 ? n : lf + 1;
        continue;
      }
    }
    const fields = [];
    let ended;
    let quoted = false;
    do {
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
          ended = readUnq('"');
          fields.push(fld);
          continue;
        }
        let value = text.slice(open + 1, closed);
        if (doubled) value = value.replaceAll('""', '"');
        if (value.indexOf('\n') !== -1 || value.indexOf('\r') !== -1) {
          // Each CRLF or lone CR inside quotes is one LF.
          value = value.replace(/\r\n?/g, '\n');
          let nl = 0;
          for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) === 10) nl += 1;
          line += nl;
        }
        pos = closed + 1;
        if (pos >= n) {
          fields.push(value);
          ended = 2;
        } else {
          const c = text.charCodeAt(pos);
          if (c === 44) {
            pos += 1;
            fields.push(value);
            ended = 0;
          } else if (c === 10) {
            pos += 1;
            line += 1;
            fields.push(value);
            ended = 1;
          } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
            pos += 2;
            line += 1;
            fields.push(value);
            ended = 1;
          } else {
            // What follows the closing quote is appended as it stands.
            ended = readUnq(value);
            if (fld.length > value.length) {
              errors.push({ code: 'quote_junk', line: recLine, row: recRow });
            }
            fields.push(fld);
          }
        }
      } else {
        quoted = false;
        ended = readUnq('');
        fields.push(fld);
      }
    } while (ended === 0);

    // A line that held only stray CRs is left with no characters: no record.
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    emit(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
