// Variant C — regex-hybrid: unquoted fields are scanned by one sticky regex
// /[^,\r\n]*/y per field (a single native scan to the next delimiter); quoted
// fields use the same indexOf closing-quote jumps as variant B.
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

  // Sticky regex: the longest run of characters that are not a delimiter.
  const RE_U = /[^,\r\n]*/y;

  // Reads an unquoted field from pos, starting with value v0.
  // Returns 0 = ended at a comma, 1 = ended at a line break, 2 = ended at end of text.
  // Sets fld to the field value. Pushes stray_cr errors as met.
  function readUnq(v0) {
    let value = v0;
    for (;;) {
      RE_U.lastIndex = pos;
      const m = RE_U.exec(text);
      const chunk = m[0];
      value += chunk;
      pos += chunk.length;
      if (pos >= n) {
        fld = value;
        return 2;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        fld = value;
        return 0;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        fld = value;
        return 1;
      }
      // A CR: CRLF is a line break, a lone CR is dropped with an error, then keep reading.
      if (text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        fld = value;
        return 1;
      }
      errors.push({ code: 'stray_cr', line: recLine, row: recRow });
      pos += 1;
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
