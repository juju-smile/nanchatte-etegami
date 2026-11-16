// 用紙設定を描画・文字・背景から分離し、各層はこの寸法を参照します。
const paperSettings = { orientation: 'landscape', width: 1400, height: 900 };
// 保存対象の変更だけを追跡。タブ移動・表示倍率変更では未保存にしません。
const workState = { revision: 0, savedRevision: 0 };
const markEdited = () => { workState.revision += 1; };

// タッチ後に互換クリックを生成しないブラウザでも、ボタンを一度だけ確実に操作します。
// スクロール・長いドラッグ・文字移動はボタン操作として扱いません。
(() => {
  let candidate = null;
  let lastTap = null;
  const controlFrom = event => event.target.closest('button:not(#letter-text), a[href]');
  document.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch' || !event.isPrimary) return;
    const control = controlFrom(event);
    candidate = control && !control.disabled ? { control, id: event.pointerId, x: event.clientX, y: event.clientY } : null;
  }, true);
  document.addEventListener('pointercancel', () => { candidate = null; }, true);
  document.addEventListener('pointerup', event => {
    if (!candidate || event.pointerId !== candidate.id) return;
    const tap = candidate;
    candidate = null;
    if (controlFrom(event) !== tap.control || Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 12) return;
    event.preventDefault();
    lastTap = { control: tap.control, time: performance.now() };
    tap.control.click();
  }, true);
  document.addEventListener('click', event => {
    if (event.isTrusted && event.detail > 0 && lastTap && controlFrom(event) === lastTap.control && performance.now() - lastTap.time < 700) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
})();

// 画面の切り替えを管理します。
(() => {
  const screens = [...document.querySelectorAll('.screen')];
  const titles = { home: 'なんちゃって絵手紙', create: '絵手紙を作る' };
  function showScreen(moveFocus = true) {
    const requested = window.location.hash.slice(1);
    const id = Object.hasOwn(titles, requested) ? requested : 'home';
    screens.forEach(screen => { screen.hidden = screen.id !== id; });
    document.body.classList.toggle('editing', id === 'create');
    document.title = id === 'home' ? titles.home : `${titles[id]} | ${titles.home}`;
    if (moveFocus) {
      document.querySelector(`#${id} h1`).focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }
  }
  window.addEventListener('hashchange', () => showScreen());
  showScreen(false);
})();

// 線画・色塗りは別のCanvas。操作履歴は共通にして、塗りも一回ずつ取り消せます。
(() => {
  const canvas = document.getElementById('drawing-space');
  const paint = document.getElementById('paint-space');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const paintContext = paint.getContext('2d');
  const penButton = document.getElementById('pen-tool');
  const fillButton = document.getElementById('fill-tool');
  const eraserButton = document.getElementById('eraser-tool');
  const undoButton = document.getElementById('undo-tool');
  const status = document.getElementById('drawing-status');
  const palette = [...document.querySelectorAll('[data-fill-color]')];
  const history = [];
  let view = { scale: 1, x: 0, y: 0 };
  let tool = 'pen';
  let fillColor = palette[0].dataset.fillColor;
  let fillLabel = palette[0].dataset.label;
  let activeStroke = null;
  let pointerId = null;

  function updateTools(message) {
    penButton.setAttribute('aria-pressed', String(tool === 'pen'));
    fillButton.setAttribute('aria-pressed', String(tool === 'fill'));
    eraserButton.setAttribute('aria-pressed', String(tool === 'eraser'));
    palette.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.fillColor === fillColor)));
    undoButton.disabled = history.length === 0;
    canvas.classList.toggle('erasing', tool === 'eraser');
    canvas.classList.toggle('filling', tool === 'fill');
    status.textContent = message || (tool === 'pen' ? '黒ペンを選んでいます。' : tool === 'eraser' ? '消しゴムを選んでいます。' : fillLabel + 'を選んでいます。');
  }
  function pointFrom(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: ((event.clientX - rect.left) * canvas.width / rect.width - view.x) / view.scale, y: ((event.clientY - rect.top) * canvas.height / rect.height - view.y) / view.scale };
  }
  function segment(target, stroke, from, to) {
    target.save(); target.translate(view.x, view.y); target.scale(view.scale, view.scale);
    target.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
    target.strokeStyle = '#333333'; target.fillStyle = '#333333'; target.lineWidth = stroke.width; target.lineCap = 'round'; target.lineJoin = 'round';
    target.beginPath();
    if (from.x === to.x && from.y === to.y) { target.arc(to.x, to.y, stroke.width / 2, 0, Math.PI * 2); target.fill(); }
    else { target.moveTo(from.x, from.y); target.lineTo(to.x, to.y); target.stroke(); }
    target.restore();
  }
  function drawSegment(stroke, from, to) {
    segment(context, stroke, from, to);
    if (stroke.tool === 'eraser') segment(paintContext, stroke, from, to);
  }
  function finishStroke() {
    if (!activeStroke) return;
    history.push(activeStroke); markEdited(); activeStroke = null;
    const id = pointerId; pointerId = null;
    if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    updateTools();
  }
  function redraw() {
    context.clearRect(0, 0, canvas.width, canvas.height); paintContext.clearRect(0, 0, paint.width, paint.height);
    history.forEach(action => {
      if (action.type === 'fill') {
        // 保存時の用紙座標→元座標→現在の用紙座標。縦横変更を繰り返しても劣化させません。
        paintContext.save(); paintContext.translate(view.x, view.y); paintContext.scale(view.scale, view.scale);
        paintContext.scale(1 / action.view.scale, 1 / action.view.scale); paintContext.translate(-action.view.x, -action.view.y);
        paintContext.globalCompositeOperation = 'destination-out'; paintContext.drawImage(action.mask, action.x, action.y);
        paintContext.globalCompositeOperation = 'source-over'; paintContext.drawImage(action.image, action.x, action.y); paintContext.restore();
      } else {
        drawSegment(action, action.points[0], action.points[0]);
        for (let i = 1; i < action.points.length; i++) drawSegment(action, action.points[i - 1], action.points[i]);
      }
    });
  }

  function fillAt(point) {
    const width = canvas.width, height = canvas.height, length = width * height;
    const x = Math.floor(point.x * view.scale + view.x), y = Math.floor(point.y * view.scale + view.y);
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const ink = context.getImageData(0, 0, width, height).data;
    const blocked = new Uint8Array(length);
    // アンチエイリアスを含む輪郭を境界にし、1pxだけ補強して小さな隙間に配慮します。
    for (let p = 0; p < length; p++) if (ink[p * 4 + 3] >= 32) {
      const px = p % width, py = Math.floor(p / width);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (px + dx >= 0 && px + dx < width && py + dy >= 0 && py + dy < height) blocked[p + dy * width + dx] = 1;
      }
    }
    const seed = y * width + x;
    if (blocked[seed]) { updateTools('線の上ではなく、囲まれた内側をクリックしてください。'); return; }
    const queue = new Int32Array(length);
    let head = 0, tail = 1, touchesEdge = false;
    queue[0] = seed; blocked[seed] = 1;
    const visit = p => { if (!blocked[p]) { blocked[p] = 1; queue[tail++] = p; } };
    while (head < tail) {
      const p = queue[head++], px = p % width, py = Math.floor(p / width);
      if (px === 0 || py === 0 || px === width - 1 || py === height - 1) { touchesEdge = true; break; }
      if (tail > length * 0.65) { touchesEdge = true; break; }
      visit(p - 1); visit(p + 1); visit(p - width); visit(p + width);
    }
    // 用紙の端へ漏れる領域・極端に大きい領域は確定せず、全面塗りを防ぎます。
    if (touchesEdge) { updateTools('線が開いているか、絵の外側です。線を閉じて、内側をクリックしてください。'); return; }
    // 塗った部分だけを履歴に残し、スマホでのメモリ消費を抑えます。
    let minX = width, minY = height, maxX = 0, maxY = 0;
    for (let i = 0; i < tail; i++) {
      const px = queue[i] % width, py = Math.floor(queue[i] / width);
      minX = Math.min(minX, px); minY = Math.min(minY, py); maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
    }
    const cropWidth = maxX - minX + 1, cropHeight = maxY - minY + 1;
    const image = document.createElement('canvas'); image.width = cropWidth; image.height = cropHeight;
    const target = image.getContext('2d'), result = target.createImageData(cropWidth, cropHeight);
    const rgb = fillColor.slice(1).match(/../g).map(value => parseInt(value, 16));
    // 同じ領域を重ね塗りしたときも濃くなりすぎないよう、先の色を置き換えるマスクを保持します。
    const mask = document.createElement('canvas'); mask.width = cropWidth; mask.height = cropHeight;
    const maskContext = mask.getContext('2d'), maskPixels = maskContext.createImageData(cropWidth, cropHeight);
    for (let i = 0; i < tail; i++) {
      const p = queue[i], px = p % width, py = Math.floor(p / width), offset = ((py - minY) * cropWidth + px - minX) * 4;
      const variation = 0.49 + 0.07 * Math.sin(px * 0.027) * Math.cos(py * 0.023) + 0.035 * Math.sin((px + py) * 0.013);
      result.data[offset] = rgb[0]; result.data[offset + 1] = rgb[1]; result.data[offset + 2] = rgb[2]; result.data[offset + 3] = Math.round(255 * variation);
      maskPixels.data[offset + 3] = 255;
    }
    target.putImageData(result, 0, 0); maskContext.putImageData(maskPixels, 0, 0);
    history.push({ type: 'fill', image, mask, x: minX, y: minY, view: { ...view } });
    markEdited(); redraw(); updateTools(); status.textContent = '';
  }
  canvas.addEventListener('pointerdown', event => {
    if (activeStroke || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    if (tool === 'fill') { fillAt(pointFrom(event)); return; }
    pointerId = event.pointerId; canvas.setPointerCapture(pointerId);
    activeStroke = { type: 'stroke', tool, width: (tool === 'eraser' ? 28 : 6) * canvas.width / canvas.getBoundingClientRect().width / view.scale, points: [pointFrom(event)] };
    drawSegment(activeStroke, activeStroke.points[0], activeStroke.points[0]);
  });
  canvas.addEventListener('pointermove', event => {
    if (!activeStroke || event.pointerId !== pointerId) return;
    if (event.pointerType === 'mouse' && !(event.buttons & 1)) { finishStroke(); return; }
    event.preventDefault();
    const point = pointFrom(event); drawSegment(activeStroke, activeStroke.points.at(-1), point); activeStroke.points.push(point);
  });
  canvas.addEventListener('pointerup', event => {
    if (!activeStroke || event.pointerId !== pointerId) return;
    const point = pointFrom(event); drawSegment(activeStroke, activeStroke.points.at(-1), point); activeStroke.points.push(point); finishStroke();
  });
  ['pointercancel', 'lostpointercapture'].forEach(name => canvas.addEventListener(name, event => { if (event.pointerId === pointerId) finishStroke(); }));
  window.addEventListener('blur', finishStroke); window.addEventListener('hashchange', finishStroke);
  document.addEventListener('visibilitychange', () => { if (document.hidden) finishStroke(); });
  [[penButton, 'pen'], [fillButton, 'fill'], [eraserButton, 'eraser']].forEach(([button, value]) => button.addEventListener('click', () => { finishStroke(); tool = value; updateTools(); }));
  palette.forEach(button => button.addEventListener('click', () => { finishStroke(); fillColor = button.dataset.fillColor; fillLabel = button.dataset.label; tool = 'fill'; updateTools(); }));
  undoButton.addEventListener('click', () => { finishStroke(); if (!history.length) return; history.pop(); markEdited(); redraw(); updateTools('取り消しました。'); });
  window.addEventListener('newletter', () => {
    finishStroke(); history.length = 0;
    view = { scale: 1, x: 0, y: 0 }; tool = 'pen';
    fillColor = palette[0].dataset.fillColor; fillLabel = palette[0].dataset.label;
    canvas.width = paint.width = paperSettings.width; canvas.height = paint.height = paperSettings.height;
    canvas.style.aspectRatio = canvas.width + ' / ' + canvas.height;
    redraw(); updateTools();
  });
  window.addEventListener('paperchange', () => {
    finishStroke();
    let minX = 0, minY = 0, maxX = 1400, maxY = 900;
    history.filter(action => action.type === 'stroke' && action.tool === 'pen').forEach(stroke => stroke.points.forEach(point => {
      minX = Math.min(minX, point.x - stroke.width / 2); minY = Math.min(minY, point.y - stroke.width / 2);
      maxX = Math.max(maxX, point.x + stroke.width / 2); maxY = Math.max(maxY, point.y + stroke.width / 2);
    }));
    const width = maxX - minX, height = maxY - minY, scale = Math.min(paperSettings.width / width, paperSettings.height / height);
    view = { scale, x: (paperSettings.width - width * scale) / 2 - minX * scale, y: (paperSettings.height - height * scale) / 2 - minY * scale };
    canvas.width = paint.width = paperSettings.width; canvas.height = paint.height = paperSettings.height;
    canvas.style.aspectRatio = canvas.width + ' / ' + canvas.height; redraw();
  });
  updateTools();
})();

// 絵(Canvas)に焼き込まず、文字の内容・位置と背景の種類を別々に保持します。
// 画面とPNG保存で同じ文字・背景Canvasを使います。
(() => {
  const paper = document.getElementById('letter-paper');
  const input = document.getElementById('letter-input');
  const text = document.getElementById('letter-text');
  const deleteButton = document.getElementById('delete-text');
  const backgroundButtons = [...document.querySelectorAll('[data-background]')];
  const fontButtons = [...document.querySelectorAll('[data-font]')];
  const sizeSlider = document.getElementById('text-size');
  const sizeValue = document.getElementById('text-size-value');
  const fitNote = document.getElementById('text-fit-note');
  const directionButtons = [...document.querySelectorAll('[data-direction]')];
  const paperButtons = [...document.querySelectorAll('[data-paper]')];
  const saveButton = document.getElementById('save-letter');
  const saveStatus = document.getElementById('save-status');
  const saveOptions = document.getElementById('save-options');
  const shareSavedImage = document.getElementById('share-saved-image');
  const inlineSavedImage = document.getElementById('inline-saved-image');
  const savedImage = document.getElementById('saved-image');
  const isIPhone = /iPhone|iPod/.test(navigator.userAgent);
  const preview = document.getElementById('save-preview');
  const previewImage = document.getElementById('preview-image');
  const mobileReview = document.getElementById('mobile-review');
  const reviewShareHelp = document.getElementById('review-share-help');
  const reviewStatus = document.getElementById('review-status');
  const reviewFinish = document.getElementById('review-finish');
  let pendingSave = null;
  let savedUrl = null;
  let savedFile = null;
  let lastSavedImageRevision = null;
  const fonts = {
    // 以前の筆文字の行書体を継承します。PCにない場合は明朝体で代替します。
    brush: { family: '"HGP行書体", "HG行書体", "Yu Mincho", "Hiragino Mincho ProN", serif', weight: 600, color: '#35312d' },
    // 同梱するOFL書体。色だけでなく、太く丸い日本語の字形が変わります。
    pop: { family: '"Mochiy Pop One", "HG丸ｺﾞｼｯｸM-PRO", "Hiragino Maru Gothic ProN", "Meiryo", sans-serif', weight: 400, color: '#e64d85' },
    hand: { family: '"Yomogi", "Yu Gothic", "Meiryo", sans-serif', weight: 400, color: '#594838' }
  };
  const letter = { text: { value: '', x: 140, y: 90, color: fonts.hand.color, font: 'hand', size: 72, direction: 'horizontal' }, background: 'white' };
  const textCanvas = document.createElement('canvas');
  // 画面とPNGで同じ文字Canvasを使い、書体・色・位置を一致させます。
  const displayCanvas = document.createElement('canvas');
  displayCanvas.setAttribute('aria-hidden', 'true');
  text.append(displayCanvas);
  let hasTextLayout = false;
  const backgroundCanvas = document.createElement('canvas');
  backgroundCanvas.width = paperSettings.width;
  backgroundCanvas.height = paperSettings.height;
  let fontRequest = 0;
  let drag = null;

  function decoratePop(size, vertical) {
    // 字形の透明度をマスクにし、文字全体へ虹色を重ねます。
    // 縦書きの一文字ごとの回転・移動に左右されず、上→下に虹がつながります。
    const glyphs = document.createElement('canvas');
    glyphs.width = textCanvas.width; glyphs.height = textCanvas.height;
    const glyphContext = glyphs.getContext('2d');
    glyphContext.drawImage(textCanvas, 0, 0);
    glyphContext.globalCompositeOperation = 'source-in';
    const gradient = glyphContext.createLinearGradient(12, 12, vertical ? 12 : glyphs.width - 12, vertical ? glyphs.height - 12 : 12);
    ['#eb4960', '#ef8730', '#d7b620', '#42a55b', '#32b7c8', '#4977d9', '#a052bf'].forEach((color, index) => gradient.addColorStop(index / 6, color));
    glyphContext.fillStyle = gradient;
    glyphContext.fillRect(0, 0, glyphs.width, glyphs.height);

    // 白い縁取りで色の違う背景でも読みやすくします。装飾の大きさは文字サイズに追従します。
    const outline = document.createElement('canvas');
    outline.width = textCanvas.width; outline.height = textCanvas.height;
    const outlineContext = outline.getContext('2d');
    const radius = Math.max(2, size * 0.035);
    outlineContext.drawImage(textCanvas, 0, 0);
    for (let index = 0; index < 12; index++) {
      const angle = index * Math.PI * 2 / 12;
      outlineContext.drawImage(textCanvas, Math.cos(angle) * radius, Math.sin(angle) * radius);
    }
    outlineContext.globalCompositeOperation = 'source-in';
    outlineContext.fillStyle = '#fffdf9'; outlineContext.fillRect(0, 0, outline.width, outline.height);
    const context = textCanvas.getContext('2d');
    context.clearRect(0, 0, textCanvas.width, textCanvas.height);
    context.save();
    context.shadowColor = 'rgba(74,55,95,0.22)'; context.shadowBlur = Math.max(1, size * 0.025);
    context.shadowOffsetY = Math.max(1, size * 0.025);
    context.drawImage(outline, 0, 0); context.restore();
    context.drawImage(glyphs, 0, 0);
  }

  function renderText() {
    sizeValue.value = `${letter.text.size}px`;
    sizeSlider.setAttribute('aria-valuetext', `${letter.text.size}ピクセル`);
    fitNote.textContent = '';
    text.hidden = !letter.text.value.trim();
    text.setAttribute('aria-label', `${letter.text.value}。ドラッグまたは矢印キーで移動できます`);
    if (text.hidden) { hasTextLayout = false; return; }
    const previousCenter = hasTextLayout ? { x: letter.text.x + displayCanvas.width / 2, y: letter.text.y + displayCanvas.height / 2 } : null;
    const context = textCanvas.getContext('2d');
    const preset = fonts[letter.text.font];
    const size = letter.text.size;
    const pop = letter.text.font === 'pop';
    const decorationInset = pop ? Math.ceil(size * 0.07) : 0;
    const cosine = 1;
    const sine = 0;
    const vertical = letter.text.direction === 'vertical';
    const maxWidth = paperSettings.width * 0.92;
    const maxHeight = paperSettings.height * 0.92;
    const graphemes = paragraph => typeof Intl.Segmenter === 'function'
      ? [...new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(paragraph)].map(item => item.segment)
      : Array.from(paragraph);
    let lines, left, right, ascent, descent, lineHeight, width, height;
    const popEmoji = [];
    const isEmoji = character => /\p{Extended_Pictographic}/u.test(character);
    let layoutLimit = vertical ? maxHeight - 24 : maxWidth - 40;
    let bestLayout = null;
    // サイズは指定値のまま、折り返し位置だけを調整します。
    // 自動縮小すると、スライダーを動かしても実際の字が同じ大きさになるためです。
    while (true) {
      context.font = `${preset.weight} ${size}px ${preset.family}`;
      lines = [];
      for (const paragraph of letter.text.value.replace(/\t/g, '    ').split('\n')) {
        let line = [];
        const capacity = Math.max(1, Math.floor(layoutLimit / (size * 1.25)));
        for (const character of graphemes(paragraph)) {
          const overflows = vertical ? line.length >= capacity : context.measureText([...line, character].join('')).width > layoutLimit;
          if (line.length && overflows) {
            // 句読点が縦の列頭に出ないよう、前の一文字も次の列へ送ります。
            const tail = vertical && /[、。！？）」』】〉》]/u.test(character) && line.length > 1 ? [line.pop()] : [];
            lines.push(line);
            line = tail;
          }
          line.push(character);
        }
        lines.push(line);
      }
      left = 0; right = 0; ascent = size; descent = size * 0.3;
      if (vertical) {
        width = lines.length * size * 1.6 + 24;
        height = Math.max(...lines.map(line => Math.max(1, line.length))) * size * 1.25 + 24;
      } else {
        lines.forEach(line => {
          const metrics = context.measureText(line.join(''));
          left = Math.max(left, metrics.actualBoundingBoxLeft || 0);
          right = Math.max(right, metrics.width, metrics.actualBoundingBoxRight || 0);
          ascent = Math.max(ascent, metrics.actualBoundingBoxAscent || 0);
          descent = Math.max(descent, metrics.actualBoundingBoxDescent || 0);
        });
        lineHeight = Math.max(size * 1.6, ascent + descent);
        width = left + right + 24;
        height = (lines.length - 1) * lineHeight + ascent + descent + 24;
      }
      const overflow = Math.max((width * cosine + height * sine + 4 + decorationInset * 2) / maxWidth, (width * sine + height * cosine + 4 + decorationInset * 2) / maxHeight);
      if (!bestLayout || overflow < bestLayout.overflow) {
        bestLayout = { lines, left, right, ascent, descent, lineHeight, width, height, overflow };
      }
      if (overflow <= 1 || layoutLimit <= size) break;
      layoutLimit = Math.max(size, layoutLimit - size * (vertical ? 1.25 : 1));
    }
    ({ lines, left, right, ascent, descent, lineHeight, width, height } = bestLayout);
    textCanvas.width = Math.ceil(width) + decorationInset * 2;
    textCanvas.height = Math.ceil(height) + decorationInset * 2;
    context.font = `${preset.weight} ${size}px ${preset.family}`;
    context.fillStyle = letter.text.color;
    if (letter.text.font === 'hand') {
      context.strokeStyle = letter.text.color;
      context.lineWidth = Math.max(1, size * 0.028);
      context.lineJoin = 'round';
    }
    context.textBaseline = 'alphabetic';
    context.save();
    context.translate(decorationInset, decorationInset);
    if (vertical) {
      lines.forEach((column, columnIndex) => column.forEach((character, rowIndex) => {
        context.save();
        let x = textCanvas.width - decorationInset * 2 - 12 - size * 0.8 - columnIndex * size * 1.6;
        let y = 12 + size * 0.625 + rowIndex * size * 1.25;
        // 和文の約物を縦用に扱います。句読点・小書き文字は右上、長音や括弧は回転します。
        if (/[、。，．ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ]/u.test(character)) { x += size * 0.23; y -= size * 0.23; }
        context.translate(x, y);
        if (/[ー―—－…‥〜～「」『』（）()［］\[\]【】〈〉《》｛｝{}]/u.test(character)) context.rotate(Math.PI / 2);
        const metrics = context.measureText(character);
        const inkLeft = metrics.actualBoundingBoxLeft || 0;
        const inkRight = metrics.actualBoundingBoxRight || metrics.width;
        const inkAscent = metrics.actualBoundingBoxAscent || 0;
        const inkDescent = metrics.actualBoundingBoxDescent || 0;
        // 字面の中心を基準にして、句読点も上で指定した右上の位置に揃えます。
        const glyphX = (inkLeft - inkRight) / 2;
        const glyphY = (inkAscent - inkDescent) / 2;
        if (letter.text.font === 'hand') context.strokeText(character, glyphX, glyphY);
        if (pop && isEmoji(character)) popEmoji.push({ character, x: glyphX, y: glyphY, transform: context.getTransform() });
        else context.fillText(character, glyphX, glyphY);
        context.restore();
      }));
    } else {
      lines.forEach((line, index) => {
        const lineText = line.join('');
        const lineY = 12 + ascent + index * lineHeight;
        if (letter.text.font === 'hand') context.strokeText(lineText, 12 + left, lineY);
        if (pop && graphemes(lineText).some(isEmoji)) {
          let offset = 0;
          for (const character of graphemes(lineText)) {
            const x = 12 + left + offset;
            if (isEmoji(character)) popEmoji.push({ character, x, y: lineY, transform: context.getTransform() });
            else context.fillText(character, x, lineY);
            offset += context.measureText(character).width;
          }
        } else context.fillText(lineText, 12 + left, lineY);
      });
    }
    context.restore();
    if (pop) {
      decoratePop(size, vertical);
      // カラー絵文字は虹色マスクの対象から外し、元の色と形で重ねます。
      const emojiContext = textCanvas.getContext('2d');
      emojiContext.font = `${preset.weight} ${size}px ${preset.family}`;
      emojiContext.textBaseline = 'alphabetic';
      popEmoji.forEach(({ character, x, y, transform }) => {
        emojiContext.save();
        emojiContext.setTransform(transform);
        emojiContext.fillText(character, x, y);
        emojiContext.restore();
      });
    }
    // 字形の輪郭が切れない余白を確保します。
    displayCanvas.width = Math.ceil(textCanvas.width * cosine + textCanvas.height * sine) + 4;
    displayCanvas.height = Math.ceil(textCanvas.width * sine + textCanvas.height * cosine) + 4;
    const displayContext = displayCanvas.getContext('2d');
    displayContext.translate(displayCanvas.width / 2, displayCanvas.height / 2);
    displayContext.drawImage(textCanvas, -textCanvas.width / 2, -textCanvas.height / 2);
    if (previousCenter) {
      letter.text.x = previousCenter.x - displayCanvas.width / 2;
      letter.text.y = previousCenter.y - displayCanvas.height / 2;
    }
    hasTextLayout = true;
    text.style.width = `${displayCanvas.width / paperSettings.width * 100}%`;
    text.style.height = `${displayCanvas.height / paperSettings.height * 100}%`;
    if (bestLayout.overflow > 1) fitNote.textContent = `現在の${size}pxでは文字の一部が紙からはみ出す場合があります。文章を短くするか、文字サイズを調整してから保存してください。`;
    placeText();
  }

  async function prepareFont() {
    const request = ++fontRequest;
    const preset = fonts[letter.text.font];
    renderText();
    try {
      await document.fonts.load(`${preset.weight} ${letter.text.size}px ${preset.family}`, letter.text.value || 'ありがとう');
      await document.fonts.ready;
      if (request === fontRequest) renderText();
    } catch {
      // フォントが使えない場合も、標準の代替フォントで描画を続けます。
      if (request === fontRequest) renderText();
    }
  }

  function renderBackground() {
    const context = backgroundCanvas.getContext('2d');
    context.fillStyle = { white: '#ffffff', washi: '#f0e5d0', cream: '#fff4cf' }[letter.background];
    context.fillRect(0, 0, paperSettings.width, paperSettings.height);
    if (letter.background === 'washi') {
      // 毎回同じ繊維模様を作り、外部画像なしで画面とPNGに共有します。
      let seed = 42;
      const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
      for (let index = 0; index < 6500; index++) {
        const x = random() * paperSettings.width;
        const y = random() * paperSettings.height;
        context.strokeStyle = index % 2 ? 'rgba(255,255,255,0.32)' : 'rgba(145,117,76,0.10)';
        context.lineWidth = 0.5 + random() * 0.7;
        context.beginPath();
        context.moveTo(x, y);
        context.lineTo(x + random() * 3 - 1.5, y + random() * 12 + 3);
        context.stroke();
      }
    }
    paper.style.backgroundImage = `url("${backgroundCanvas.toDataURL('image/png')}")`;
    paper.style.backgroundSize = '100% 100%';
  }

  function placeText() {
    if (text.hidden || !paper.clientWidth || !paper.clientHeight) return;
    const maxX = Math.max(0, paperSettings.width - displayCanvas.width);
    const maxY = Math.max(0, paperSettings.height - displayCanvas.height);
    letter.text.x = Math.max(0, Math.min(maxX, letter.text.x));
    letter.text.y = Math.max(0, Math.min(maxY, letter.text.y));
    text.style.left = `${letter.text.x / paperSettings.width * 100}%`;
    text.style.top = `${letter.text.y / paperSettings.height * 100}%`;
  }

  input.addEventListener('input', () => {
    if (letter.text.value !== input.value) markEdited();
    letter.text.value = input.value;
    deleteButton.disabled = !letter.text.value;
    // 入力をHTMLとして解釈せず、日本語をCanvasに描きます。
    prepareFont();
  });
  deleteButton.addEventListener('click', () => {
    if (letter.text.value) markEdited();
    stopDragging();
    letter.text = { ...letter.text, value: '', x: paperSettings.width * 0.1, y: paperSettings.height * 0.1 };
    input.value = '';
    fontRequest += 1;
    hasTextLayout = false;
    text.hidden = true;
    fitNote.textContent = '';
    deleteButton.disabled = true;
    input.focus();
  });

  backgroundButtons.forEach(button => button.addEventListener('click', () => {
    paper.classList.remove(`paper-${letter.background}`);
    if (letter.background !== button.dataset.background) markEdited();
    letter.background = button.dataset.background;
    paper.classList.add(`paper-${letter.background}`);
    renderBackground();
    backgroundButtons.forEach(option => option.setAttribute('aria-pressed', String(option === button)));
  }));

  fontButtons.forEach(button => {
    const preset = fonts[button.dataset.font];
    const sample = button.querySelector('.font-sample');
    sample.style.fontFamily = preset.family;
    sample.style.fontWeight = preset.weight;
    sample.style.color = preset.color;
    button.addEventListener('click', () => {
      stopDragging();
      if (letter.text.font !== button.dataset.font) markEdited();
      letter.text.font = button.dataset.font;
      letter.text.color = fonts[letter.text.font].color;
      fontButtons.forEach(option => option.setAttribute('aria-pressed', String(option === button)));
      prepareFont();
    });
  });

  function bindTextSetting(buttons, key, dataKey) {
    buttons.forEach(button => button.addEventListener('click', () => {
      stopDragging();
      if (letter.text[key] !== button.dataset[dataKey]) markEdited();
      letter.text[key] = button.dataset[dataKey];
      buttons.forEach(option => option.setAttribute('aria-pressed', String(option === button)));
      prepareFont();
    }));
  }
  bindTextSetting(directionButtons, 'direction', 'direction');
  sizeSlider.addEventListener('input', () => {
    stopDragging();
    if (letter.text.size !== Number(sizeSlider.value)) markEdited();
    letter.text.size = Number(sizeSlider.value);
    renderText();
  });
  paperButtons.forEach(button => button.addEventListener('click', () => {
    if (button.dataset.paper === paperSettings.orientation) return;
    stopDragging();
    markEdited();
    const oldWidth = paperSettings.width;
    const oldHeight = paperSettings.height;
    paperSettings.orientation = button.dataset.paper;
    paperSettings.width = paperSettings.orientation === 'portrait' ? 900 : 1400;
    paperSettings.height = paperSettings.orientation === 'portrait' ? 1400 : 900;
    letter.text.x *= paperSettings.width / oldWidth;
    letter.text.y *= paperSettings.height / oldHeight;
    window.dispatchEvent(new Event('paperchange'));
    paper.classList.toggle('portrait', paperSettings.orientation === 'portrait');
    backgroundCanvas.width = paperSettings.width;
    backgroundCanvas.height = paperSettings.height;
    renderBackground();
    prepareFont();
    paperButtons.forEach(option => option.setAttribute('aria-pressed', String(option === button)));
  }));

  saveButton.addEventListener('click', async () => {
    saveButton.disabled = true;
    saveStatus.textContent = '画像を準備しています…';
    let url;
    try {
      stopDragging();
      await prepareFont();
      if (!paper.clientWidth) throw new Error('お絵描き画面を開いてから保存してください。');
      const output = document.createElement('canvas');
      output.width = paperSettings.width;
      output.height = paperSettings.height;
      const context = output.getContext('2d');
      context.drawImage(backgroundCanvas, 0, 0);
      context.drawImage(document.getElementById('paint-space'), 0, 0);
      context.drawImage(document.getElementById('drawing-space'), 0, 0);
      if (!text.hidden) context.drawImage(displayCanvas, letter.text.x, letter.text.y);
      const snapshotRevision = workState.revision;
      const blob = await new Promise((resolve, reject) => output.toBlob(result => result ? resolve(result) : reject(new Error('画像を作成できませんでした。')), 'image/png'));
      // iPhoneのHTMLビューアーでは外部リンクがブロックされるため、画像をページ内に埋め込みます。
      const imageData = isIPhone ? output.toDataURL('image/png') : null;
      url = isIPhone ? null : URL.createObjectURL(blob);
      const now = new Date();
      const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      pendingSave = { url, imageData, revision: snapshotRevision, file: new File([blob], `なんちゃって絵手紙_${date}.png`, { type: 'image/png' }) };
      if (matchMedia('(max-width:959px)').matches) {
        savedImage.src = imageData || url;
        inlineSavedImage.hidden = false;
        shareSavedImage.hidden = false;
        reviewShareHelp.hidden = false;
        reviewFinish.hidden = true;
        reviewStatus.textContent = '';
        reviewShareHelp.textContent = isIPhone
          ? '「保存する」を押し、共有メニューから「画像を保存」を選ぶと、iPhoneの写真に保存できます。'
          : '「保存する」を押すと、PNG画像をダウンロードできます。';
        mobileReview.showModal();
        saveStatus.textContent = '';
      } else {
        previewImage.src = imageData || url;
        document.getElementById('preview-title').textContent = 'この画像を保存しますか？';
        document.getElementById('confirm-save').textContent = 'この画像を保存';
        preview.showModal();
        saveStatus.textContent = '完成画像を確認してください。';
      }
    } catch (error) {
      saveStatus.textContent = `保存を開始できませんでした。${error.message} もう一度お試しください。`;
    } finally {
      // 保存案内の画像は次回の保存まで保持し、スマホの長押し保存にも使えます。
      if (url && url !== savedUrl && url !== pendingSave?.url) URL.revokeObjectURL(url);
      saveButton.disabled = false;
    }
  });

  document.getElementById('cancel-save').addEventListener('click', () => preview.close());
  preview.addEventListener('close', () => {
    if (pendingSave) {
      if (pendingSave.url) URL.revokeObjectURL(pendingSave.url);
      pendingSave = null;
      saveStatus.textContent = '保存を取り消しました。編集を続けられます。';
    }
    previewImage.removeAttribute('src');
  });
  document.getElementById('confirm-save').addEventListener('click', () => {
    if (!pendingSave) return;
    if (savedUrl) URL.revokeObjectURL(savedUrl);
    savedUrl = pendingSave.url;
    savedFile = pendingSave.file;
    const imageData = pendingSave.imageData;
    lastSavedImageRevision = pendingSave.revision;
    if (!isIPhone) workState.savedRevision = pendingSave.revision;
    pendingSave = null;
    if (isIPhone) {
      savedImage.src = imageData;
      inlineSavedImage.hidden = false;
    } else {
      const link = document.createElement('a');
      link.href = savedUrl;
      link.download = savedFile.name;
      document.body.append(link);
      link.click();
      link.remove();
      inlineSavedImage.hidden = true;
    }
    saveOptions.hidden = isIPhone;
    shareSavedImage.hidden = true;
    shareSavedImage.textContent = '共有メニューで保存';
    try { shareSavedImage.hidden = !(isIPhone && navigator.share && navigator.canShare && navigator.canShare({ files: [savedFile] })); } catch { /* 長押しで保存できます。 */ }
    reviewShareHelp.hidden = shareSavedImage.hidden;
    preview.close();
    saveStatus.textContent = isIPhone
      ? '完成画像を表示しています。'
      : 'ダウンロード先で画像を確認してください。';
    if (isIPhone) {
      mobileReview.showModal();
      document.getElementById('review-edit').focus({ preventScroll: true });
    } else {
      saveOptions.scrollIntoView({ block: 'nearest' });
      document.getElementById('finish-letter').focus({ preventScroll: true });
    }
  });
  document.getElementById('review-edit').addEventListener('click', () => {
    mobileReview.close();
    if (pendingSave?.url) URL.revokeObjectURL(pendingSave.url);
    pendingSave = null;
    savedImage.removeAttribute('src');
    inlineSavedImage.hidden = true;
    saveStatus.textContent = '編集を続けられます。';
  });
  mobileReview.addEventListener('cancel', event => {
    event.preventDefault();
    document.getElementById('review-edit').click();
  });
  reviewFinish.addEventListener('click', () => {
    mobileReview.close();
    if (pendingSave?.url) URL.revokeObjectURL(pendingSave.url);
    pendingSave = null;
    document.getElementById('finish-letter').click();
  });
  document.getElementById('finish-letter').addEventListener('click', () => {
    // iPhoneで保存後に編集した場合は、古い画像を保存済みとして扱わない。
    if (isIPhone && lastSavedImageRevision === workState.revision) workState.savedRevision = workState.revision;
    document.querySelector('#create > .back').click();
  });

  shareSavedImage.addEventListener('click', async () => {
    const file = pendingSave?.file || savedFile;
    if (!file) return;
    if (isIPhone) {
      try {
        if (!navigator.share || (navigator.canShare && !navigator.canShare({ files: [file] }))) throw new Error('共有メニューを開けません。');
        // ボタンの操作から直接共有メニューを開きます。
        await navigator.share({ files: [file], title: 'なんちゃって絵手紙' });
        lastSavedImageRevision = pendingSave?.revision ?? lastSavedImageRevision;
        reviewStatus.textContent = '「写真」に画像があることを確認してから、ホームへ戻ってください。';
        reviewFinish.hidden = false;
      } catch (error) {
        reviewStatus.textContent = error.name === 'AbortError'
          ? '保存を取り消しました。もう一度「保存する」を押せます。'
          : '共有メニューを開けませんでした。画像を長押しして保存してください。';
        if (error.name !== 'AbortError') reviewFinish.hidden = false;
      }
    } else {
      const link = document.createElement('a');
      link.href = pendingSave?.url || savedUrl;
      link.download = file.name;
      document.body.append(link);
      link.click();
      link.remove();
      lastSavedImageRevision = pendingSave?.revision ?? lastSavedImageRevision;
      workState.savedRevision = lastSavedImageRevision;
      reviewStatus.textContent = 'ダウンロード先に画像があることを確認してから、ホームへ戻ってください。';
      reviewFinish.hidden = false;
    }
  });

  function stopDragging() {
    if (!drag) return;
    const id = drag.id;
    drag = null;
    if (text.hasPointerCapture(id)) text.releasePointerCapture(id);
    text.classList.remove('dragging');
  }
  text.addEventListener('pointerdown', event => {
    if (drag || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    text.focus({ preventScroll: true });
    const rect = text.getBoundingClientRect();
    drag = { id: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
    text.setPointerCapture(event.pointerId);
    text.classList.add('dragging');
  });
  function moveText(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const previous = { x: letter.text.x, y: letter.text.y };
    const rect = paper.getBoundingClientRect();
    letter.text.x = (event.clientX - rect.left - paper.clientLeft - drag.offsetX) * paperSettings.width / paper.clientWidth;
    letter.text.y = (event.clientY - rect.top - paper.clientTop - drag.offsetY) * paperSettings.height / paper.clientHeight;
    placeText();
    if (letter.text.x !== previous.x || letter.text.y !== previous.y) markEdited();
  }
  text.addEventListener('pointermove', event => {
    if (drag && event.pointerType === 'mouse' && (event.buttons & 1) === 0) { stopDragging(); return; }
    if (drag) event.preventDefault();
    moveText(event);
  });
  text.addEventListener('pointerup', event => {
    if (drag && event.pointerId === drag.id) { moveText(event); stopDragging(); }
  });
  ['pointercancel', 'lostpointercapture'].forEach(name => text.addEventListener(name, event => {
    if (drag && event.pointerId === drag.id) stopDragging();
  }));
  text.addEventListener('keydown', event => {
    const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (!Object.hasOwn(directions, event.key)) return;
    event.preventDefault();
    const [x, y] = directions[event.key];
    markEdited();
    letter.text.x += x * 10;
    letter.text.y += y * 10;
    placeText();
  });
  window.addEventListener('blur', stopDragging);
  window.addEventListener('hashchange', () => { stopDragging(); placeText(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopDragging(); });
  new ResizeObserver(() => { stopDragging(); placeText(); }).observe(paper);
  window.addEventListener('newletter', () => {
    stopDragging(); fontRequest += 1; hasTextLayout = false;
    letter.text = { value: '', x: 140, y: 90, color: fonts.hand.color, font: 'hand', size: 72, direction: 'horizontal' };
    letter.background = 'white'; input.value = ''; sizeSlider.value = '72'; deleteButton.disabled = true;
    fitNote.textContent = ''; paper.classList.remove('portrait', 'paper-cream', 'paper-washi'); paper.classList.add('paper-white');
    backgroundCanvas.width = paperSettings.width; backgroundCanvas.height = paperSettings.height;
    [[backgroundButtons, 'background', 'white'], [fontButtons, 'font', 'hand'], [directionButtons, 'direction', 'horizontal'], [paperButtons, 'paper', 'landscape']].forEach(([buttons, key, value]) => buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset[key] === value))));
    if (savedUrl) URL.revokeObjectURL(savedUrl);
    if (pendingSave?.url) URL.revokeObjectURL(pendingSave.url);
    pendingSave = null;
    if (mobileReview.open) mobileReview.close();
    savedUrl = null; savedFile = null; lastSavedImageRevision = null; savedImage.removeAttribute('src'); inlineSavedImage.hidden = true; saveOptions.hidden = true; shareSavedImage.hidden = true; reviewShareHelp.hidden = true; saveStatus.textContent = '';
    renderBackground(); prepareFont();
  });
  renderBackground();
  prepareFont();
})();


// 表示寸法だけを変更し、Canvasの画素数・作品座標は保持します。
(() => {
  const frame = document.querySelector('.drawing-frame');
  const paper = document.getElementById('letter-paper');
  const desktop = matchMedia('(min-width: 960px)');
  function fitPaper() {
    if (!frame.clientWidth) return;
    if (!desktop.matches) { paper.style.width = ''; return; }
    const style = getComputedStyle(frame);
    const width = frame.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height = frame.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    paper.style.width = Math.max(1, Math.min(width, (height - 2) * paperSettings.width / paperSettings.height + 2)) + 'px';
  }
  function arrangeControls() {
    document.querySelectorAll('.control-section').forEach(section => { section.open = false; });
    fitPaper();
  }
  new ResizeObserver(fitPaper).observe(frame);
  window.addEventListener('paperchange', () => requestAnimationFrame(fitPaper));
  window.addEventListener('newletter', arrangeControls);
  desktop.addEventListener('change', arrangeControls);
  arrangeControls();
})();

// 用紙への移動はURLを変更せず、編集中の画面内だけをスクロールします。
document.querySelectorAll('[data-scroll-to]').forEach(button => button.addEventListener('click', () => {
  document.querySelector(button.dataset.scrollTo).scrollIntoView({ block: 'start' });
}));

// ホームへ戻る前に未保存の変更を確認し、戻ったら白紙にします。
(() => {
  const dialog = document.getElementById('new-confirm');
  const homeDialog = document.getElementById('home-confirm');
  function clearLetter() {
    Object.assign(paperSettings, { orientation: 'landscape', width: 1400, height: 900 });
    window.dispatchEvent(new Event('newletter'));
    workState.revision = workState.savedRevision = 0;
    document.querySelector('.control-panel').scrollTop = 0;
  }
  function startNew() {
    clearLetter();
    location.hash = 'create';
  }
  function goHome() {
    clearLetter();
    location.hash = 'home';
  }
  document.querySelectorAll('a[href="#home"]').forEach(link => link.addEventListener('click', event => {
    if (document.getElementById('create').hidden) return;
    event.preventDefault();
    if (workState.revision !== workState.savedRevision) homeDialog.showModal();
    else goHome();
  }));
  document.getElementById('stay-editing').addEventListener('click', () => homeDialog.close());
  document.getElementById('discard-home').addEventListener('click', () => { homeDialog.close(); goHome(); });
  document.querySelectorAll('a[href="#create"]').forEach(link => link.addEventListener('click', event => {
    if (document.getElementById('home').hidden) return;
    event.preventDefault();
    if (workState.revision !== workState.savedRevision) dialog.showModal();
    else startNew();
  }));
  document.getElementById('keep-editing').addEventListener('click', () => { dialog.close(); location.hash = 'create'; });
  document.getElementById('start-fresh').addEventListener('click', () => { dialog.close(); startNew(); });
})();
