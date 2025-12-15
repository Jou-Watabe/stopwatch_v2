(() => {
  'use strict';

  // ===== DOM =====
  const timeEl = document.getElementById('time_area');
  const startBtn = document.getElementById('start');
  const stopBtn = document.getElementById('stop');
  const resetBtn = document.getElementById('reset');

  const rapBtn = document.getElementById('rap');
  const rapArea = document.getElementById('rap-info');

  const annotationArea = document.getElementById('annotation');
  const recordBtn = document.getElementById('check');

  const pdfInput = document.getElementById('pdf');
  const pdfView = document.getElementById('pdf_view');

  // 既存仕様維持（内部保持領域）
  const contentArea = document.getElementById('invisible');

  // ===== Stopwatch state =====
  let running = false;
  let startPerf = 0;         // performance.now() when started/resumed
  let elapsedMs = 0;         // accumulated elapsed in ms when paused
  let rafId = 0;

  // Per-page timing state (split)
  let pageCount = 0;
  let lastSplitPerf = 0;     // performance.now() at last split mark
  
  // PDF再描画用
  let lastPdfFile = null;
  let resizeObserver = null;
  let rerenderTimer = null;

  // ===== PDF.js =====
  const pdfjsLib = window['pdfjs-dist/build/pdf'];
  pdfjsLib.GlobalWorkerOptions.workerSrc = './pdfjs-dist/build/pdf.worker.js';

  function fmt(ms) {
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const milli = Math.floor(ms % 1000);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(milli).padStart(3, '0')}`;
  }

  function nowElapsed() {
    return running ? (elapsedMs + (performance.now() - startPerf)) : elapsedMs;
  }

  function tick() {
    timeEl.textContent = fmt(nowElapsed());
    rafId = requestAnimationFrame(tick);
  }

  function setUiState() {
    startBtn.disabled = running;
    stopBtn.disabled = !running;
    resetBtn.disabled = running && elapsedMs === 0; // running中はreset不可（元仕様に寄せる）
    // resetは「停止後のみ有効」に近い挙動を維持
    if (running) resetBtn.disabled = true;
  }

  function start() {
    if (running) return;
    running = true;
    startPerf = performance.now();
    // split開始点
    if (pageCount === 0) lastSplitPerf = startPerf;
    setUiState();
    cancelAnimationFrame(rafId);
    tick();
  }

  function stop() {
    if (!running) return;
    // stop時点までを反映
    elapsedMs = nowElapsed();
    running = false;
    cancelAnimationFrame(rafId);
    timeEl.textContent = fmt(elapsedMs);

    // stop時に「最後のページ区間」を確定（元仕様：stopで+1して記録）
    const stopPerf = performance.now();
    const splitMs = stopPerf - lastSplitPerf;
    pageCount += 1;
    rapArea.value += `p.${String(pageCount).padStart(2, '0')} ${fmt(splitMs)}\n`;

    // txtをダウンロード（元仕様：stopで自動保存）
    downloadTxt();

    // stop後はreset可
    setUiState();
    resetBtn.disabled = false;
  }

  function reset() {
    running = false;
    cancelAnimationFrame(rafId);
    elapsedMs = 0;
    pageCount = 0;
    lastSplitPerf = 0;

    timeEl.textContent = '00:00.000';
    rapArea.value = '';
    contentArea.value = '';
    annotationArea.value = '';

    setUiState();
    stopBtn.disabled = true;
    resetBtn.disabled = true;
  }

  function splitTime() {
    if (!running) return;
    const t = performance.now();
    const splitMs = t - lastSplitPerf;
    pageCount += 1;
    rapArea.value += `p.${String(pageCount).padStart(2, '0')} ${fmt(splitMs)}\n`;
    lastSplitPerf = t;
  }

  function record() {
    const text = (annotationArea.value || '').trimEnd();
    if (text.length === 0) return;
    // 元仕様：invisible領域に蓄積
    contentArea.value += text + '\n';
    annotationArea.value = '';
  }

  function downloadTxt() {
    const separator = '=== === === ===\n';
    const totalLine = `total ${fmt(elapsedMs)}\n`;
    const body =
      totalLine +
      separator +
      rapArea.value +
      '\n' +
      separator +
      (contentArea.value || '') +
      '\n' +
      separator +
      separator;

    const blob = new Blob([body], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);

    const ts = new Date();
    const safe =
      ts.getFullYear() +
      '-' + String(ts.getMonth() + 1).padStart(2, '0') +
      '-' + String(ts.getDate()).padStart(2, '0') +
      '_' + String(ts.getHours()).padStart(2, '0') +
      '-' + String(ts.getMinutes()).padStart(2, '0') +
      '-' + String(ts.getSeconds()).padStart(2, '0');

    a.download = `${safe}.txt`;
    a.click();

    // revoke（少し遅延させて互換性確保）
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ===== PDF Rendering =====
  function clearPdfView() {
    while (pdfView.firstChild) pdfView.removeChild(pdfView.firstChild);
  }

  function setAnnotationHeader(pageNum) {
    annotationArea.value = `p.${String(pageNum).padStart(2, '0')}\n`;
    annotationArea.focus();
    annotationArea.setSelectionRange(annotationArea.value.length, annotationArea.value.length);
  }

  async function renderPdf(file) {
    clearPdfView();

    const arrayBuf = await file.arrayBuffer();
    const typed = new Uint8Array(arrayBuf);
    const loadingTask = pdfjsLib.getDocument(typed);
    const pdf = await loadingTask.promise;

    // ページを1枚ずつ描画（順序を保つ）
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
      const page = await pdf.getPage(pageNum);

      // 画面幅に合わせたスケール
      const unscaled = page.getViewport({ scale: 1.0 });
      // コンテナ幅の概算（PDFカード内の左カラム幅に合わせる）
      const targetWidth = Math.min(520, Math.max(320, pdfView.clientWidth - 28));
      const scale = targetWidth / unscaled.width;

      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { alpha: false });

      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);

      const wrapper = document.createElement('div');
      wrapper.className = 'page';
      wrapper.setAttribute('role', 'listitem');
      wrapper.tabIndex = 0;
      wrapper.dataset.page = String(pageNum);

      const label = document.createElement('div');
      label.className = 'page__label';
      label.textContent = `p.${String(pageNum).padStart(2, '0')}`;

      wrapper.appendChild(label);
      wrapper.appendChild(canvas);
      pdfView.appendChild(wrapper);

      const onPick = () => setAnnotationHeader(pageNum);
      wrapper.addEventListener('click', onPick);
      wrapper.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPick();
        }
      });

      await page.render({ canvasContext: ctx, viewport }).promise;
    }
  }

  // ===== Events =====
  startBtn.addEventListener('click', start);
  stopBtn.addEventListener('click', stop);
  resetBtn.addEventListener('click', reset);

  rapBtn.addEventListener('click', splitTime);
  recordBtn.addEventListener('click', record);

  pdfInput.addEventListener('change', async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    if (file.type !== 'application/pdf') return;

    lastPdfFile = file;

    try {
      await renderPdf(file);

      // 既に監視していたら解除
      if (resizeObs) resizeObs.disconnect();

      // 幅が変わったら描き直す（デバウンス）
      resizeObs = new ResizeObserver(() => {
        if (!lastPdfFile) return;
        clearTimeout(rerenderTimer);
        rerenderTimer = setTimeout(() => {
          renderPdf(lastPdfFile).catch(console.error);
        }, 200);
      });
      resizeObs.observe(pdfView);

    } catch (err) {
      console.error('PDF render error:', err);
    }
  });

  // 初期UI
  setUiState();
  stopBtn.disabled = true;
  resetBtn.disabled = true;
})();
