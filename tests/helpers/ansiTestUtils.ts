export interface AnsiBoundingBox {
  cols: number;
  rows: number;
  minCol: number;
  maxCol: number;
  minRow: number;
  maxRow: number;
}

/**
 * ANSI SGR 문자열을 파싱하여 실제 가시 전경/배경 셀의 최소 바운딩 박스를 측정한다.
 * - 'foreground': 투명(배경 -1 또는 검정 #000000)이 아닌 모든 비공백/배경 셀
 * - 'nonSpace': Sextant 등 공백이 아니거나 배경색이 지정된 모든 셀
 */
export function measureAnsiBoundingBox(
  rawAnsi: string,
  mode: 'foreground' | 'nonSpace' = 'foreground',
): AnsiBoundingBox {
  let fg = -1;
  let bg = -1;
  let col = 0;
  let row = 0;
  let minCol = Infinity;
  let maxCol = -Infinity;
  let minRow = Infinity;
  let maxRow = -Infinity;
  let i = 0;

  while (i < rawAnsi.length) {
    const code = rawAnsi.charCodeAt(i);
    if (code === 0x1b && rawAnsi[i + 1] === '[') {
      const mIdx = rawAnsi.indexOf('m', i + 2);
      if (mIdx !== -1) {
        const body = rawAnsi.slice(i + 2, mIdx);
        if (body === '' || body === '0') {
          fg = -1;
          bg = -1;
        } else {
          const parts = body.split(';').map(Number);
          for (let p = 0; p < parts.length; p++) {
            const c = parts[p];
            if (c === 0) {
              fg = -1;
              bg = -1;
            } else if (c === 39) {
              fg = -1;
            } else if (c === 49) {
              bg = -1;
            } else if (c === 38 && parts[p + 1] === 2) {
              fg = (parts[p + 2] << 16) | (parts[p + 3] << 8) | parts[p + 4];
              p += 4;
            } else if (c === 48 && parts[p + 1] === 2) {
              bg = (parts[p + 2] << 16) | (parts[p + 3] << 8) | parts[p + 4];
              p += 4;
            }
          }
        }
        i = mIdx + 1;
        continue;
      }
    }

    if (code === 0x0a) {
      row++;
      col = 0;
      i++;
      continue;
    }

    const isSpace = code === 0x20;
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < rawAnsi.length) {
      i += 2;
    } else {
      i++;
    }

    const isVisible =
      mode === 'nonSpace'
        ? !isSpace || bg !== -1
        : (bg !== -1 && bg !== 0x000000) || (!isSpace && fg !== 0x000000);

    if (isVisible) {
      if (col < minCol) minCol = col;
      if (col > maxCol) maxCol = col;
      if (row < minRow) minRow = row;
      if (row > maxRow) maxRow = row;
    }
    col++;
  }

  return {
    cols: maxCol >= minCol ? maxCol - minCol + 1 : 0,
    rows: maxRow >= minRow ? maxRow - minRow + 1 : 0,
    minCol,
    maxCol,
    minRow,
    maxRow,
  };
}
