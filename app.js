/* =============================================================================
   CertiForge — Frontend Application
   -----------------------------------------------------------------------------
   Sections:
     0. Utilities & state
     1. Template upload
     2. Dataset import (SheetJS) + preview table
     3. Duplicate-email grouping (recipient model)
     4. Field model, chips, drag & drop
     5. Canvas rendering engine (text, auto-fit, shadow, QR)
     6. Canvas interaction (select / drag / keyboard)
     7. Properties panel (typography + per-row override)
     8. Row navigation
     9. Export (PNG / ZIP)
    10. SMTP modal
    11. Email composer + sending with progress & retry
   ============================================================================= */

(() => {
  'use strict';

  /* ===========================================================================
     0. UTILITIES & STATE
     =========================================================================== */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const uid = () => Math.random().toString(36).slice(2, 9);

  const FONT_FAMILIES = ['Great Vibes', 'Dancing Script', 'Playfair Display', 'Montserrat', 'Alex Brush', 'Sacramento'];
  const SMART_VARS = ['certificate_id', 'qr_code', 'date'];

  const state = {
    template: null,            // HTMLImageElement
    templateName: '',
    headers: [],               // raw header names
    keys: [],                  // normalised keys (lowercase snake)
    rows: [],                  // [{ key: value }]
    fields: [],                // Field[]
    selectedId: null,
    recipients: [],            // grouped recipients (see section 3)
    previewIndex: 0,           // index into recipients (preview targets)
    zoom: 1,
    guides: true,
    overrideMode: false,
    smtp: null,
    sendQueue: [],             // last send plan (for retry)
    sendResults: new Map()     // id -> {status, error}
  };

  /** Normalise a header to a key: "Full Name" -> "full_name" */
  function toKey(h) {
    return String(h ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'column';
  }

  /** Simple deterministic 32-bit FNV-1a hash -> base36 */
  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36).toUpperCase().padStart(7, '0');
  }

  function sanitizeFile(name) {
    return String(name).replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'certificate';
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /** Toast notifications */
  function toast(message, type = 'info', ms = 3800) {
    const icon = { success: 'fa-circle-check text-emerald-400', error: 'fa-circle-exclamation text-rose-400', info: 'fa-circle-info text-brand-400' }[type];
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<i class="fa-solid ${icon} mt-0.5"></i><span>${escapeHtml(message)}</span>`;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, ms);
  }

  /** Modal helpers */
  function openModal(id) { $(`#${id}`).classList.remove('hidden'); }
  function closeModal(id) { $(`#${id}`).classList.add('hidden'); }
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(b.dataset.close)));
  $$('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m && m.id !== 'progressModal') m.classList.add('hidden'); }));

  /** Join names with commas and "and"/"&" */
  function joinNames(names, conj = 'and') {
    const n = names.filter(Boolean);
    if (n.length <= 1) return n[0] || '';
    if (n.length === 2) return `${n[0]} ${conj} ${n[1]}`;
    return `${n.slice(0, -1).join(', ')} ${conj} ${n[n.length - 1]}`;
  }

  /** Format today's date */
  const todayStr = () => new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });

  /** Ensure Google fonts are actually loaded before drawing */
  async function ensureFonts() {
    if (!document.fonts) return;
    try {
      await Promise.all(FONT_FAMILIES.map((f) => Promise.all([
        document.fonts.load(`32px "${f}"`),
        document.fonts.load(`bold 32px "${f}"`),
        document.fonts.load(`italic 32px "${f}"`)
      ])));
    } catch (_) { /* ignore */ }
  }

  /* ===========================================================================
     1. TEMPLATE UPLOAD
     =========================================================================== */
  const canvas = $('#certCanvas');
  const ctx = canvas.getContext('2d');

  function wireDropzone(zoneId, inputId, onFile) {
    const zone = $(`#${zoneId}`);
    const input = $(`#${inputId}`);
    zone.addEventListener('click', () => input.click());
    zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', () => { if (input.files[0]) onFile(input.files[0]); input.value = ''; });
    ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('dragover'); }));
    zone.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) onFile(f); });
  }

  function loadTemplate(file) {
    if (!/^image\/(png|jpe?g)$/i.test(file.type) && !/\.(png|jpe?g)$/i.test(file.name)) {
      toast('Please upload a PNG or JPG image.', 'error'); return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      state.template = img;
      state.templateName = file.name;
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      $('#stageEmpty').classList.add('hidden');
      $('#canvasWrap').classList.remove('hidden');
      $('#templateDrop').classList.add('loaded');
      const meta = $('#templateMeta');
      meta.classList.remove('hidden');
      meta.innerHTML = `<i class="fa-solid fa-check text-emerald-400 mr-1"></i>${escapeHtml(file.name)} — ${img.naturalWidth}×${img.naturalHeight}px`;
      $('#canvasSize').textContent = `${img.naturalWidth} × ${img.naturalHeight} px`;
      fitZoom();
      render();
      toast('Template loaded.', 'success');
      URL.revokeObjectURL(url);
    };
    img.onerror = () => toast('Could not read that image.', 'error');
    img.src = url;
  }
  wireDropzone('templateDrop', 'templateInput', loadTemplate);

  // Also allow dropping an image directly onto the stage
  const stage = $('#stage');
  stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('dragover'); });
  stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));

  /* ===========================================================================
     2. DATASET IMPORT
     =========================================================================== */
  function loadDataset(file) {
    if (typeof XLSX === 'undefined') { toast('SheetJS failed to load. Check your connection.', 'error'); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
        const nonEmpty = aoa.filter((r) => r.some((c) => String(c).trim() !== ''));
        if (nonEmpty.length < 2) throw new Error('Sheet needs a header row and at least one data row.');
        applyDataset(nonEmpty[0], nonEmpty.slice(1), file.name);
      } catch (err) {
        toast(err.message || 'Failed to parse file.', 'error');
      }
    };
    reader.readAsArrayBuffer(file);
  }
  wireDropzone('dataDrop', 'dataInput', loadDataset);

  function applyDataset(headerRow, dataRows, sourceName) {
    const headers = headerRow.map((h, i) => String(h).trim() || `Column ${i + 1}`);
    // Deduplicate keys
    const seen = {};
    const keys = headers.map((h) => {
      let k = toKey(h);
      if (seen[k]) k = `${k}_${++seen[k]}`; else seen[k] = 1;
      return k;
    });
    const rows = dataRows.map((r, idx) => {
      const o = { __row: idx + 1 };
      keys.forEach((k, i) => { o[k] = String(r[i] ?? '').trim(); });
      return o;
    });

    state.headers = headers;
    state.keys = keys;
    state.rows = rows;

    // Drop fields that reference missing columns (except smart vars)
    state.fields = state.fields.filter((f) => keys.includes(f.var) || SMART_VARS.includes(f.var));
    if (state.selectedId && !state.fields.find((f) => f.id === state.selectedId)) state.selectedId = null;

    $('#dataDrop').classList.add('loaded');
    const meta = $('#dataMeta');
    meta.classList.remove('hidden');
    meta.innerHTML = `<i class="fa-solid fa-check text-emerald-400 mr-1"></i>${escapeHtml(sourceName)} — ${rows.length} rows, ${keys.length} columns`;

    populateColumnSelectors();
    renderChips();
    rebuildRecipients();
    renderTable();
    renderLayers();
    renderRowSelect();
    render();
    toast(`Imported ${rows.length} rows.`, 'success');
  }

  function guessColumn(pattern) {
    const i = state.keys.findIndex((k) => pattern.test(k));
    return i >= 0 ? state.keys[i] : state.keys[0] || '';
  }

  function populateColumnSelectors() {
    const nameSel = $('#nameColumn');
    const emailSel = $('#emailColumn');
    const opts = state.keys.map((k, i) => `<option value="${k}">${escapeHtml(state.headers[i])}</option>`).join('');
    nameSel.innerHTML = opts;
    emailSel.innerHTML = opts;
    nameSel.value = guessColumn(/^(full_?)?name$|participant|student|^name_/);
    emailSel.value = guessColumn(/e_?mail/);
  }
  $('#nameColumn').addEventListener('change', () => { rebuildRecipients(); renderTable(); renderRowSelect(); render(); });
  $('#emailColumn').addEventListener('change', () => { rebuildRecipients(); renderTable(); renderRowSelect(); render(); });

  function renderTable() {
    const thead = $('#dataTable thead');
    const tbody = $('#dataTable tbody');
    if (!state.rows.length) {
      thead.innerHTML = ''; tbody.innerHTML = '';
      $('#tableEmpty').classList.remove('hidden');
      $('#tableMeta').textContent = '0 rows';
      return;
    }
    $('#tableEmpty').classList.add('hidden');
    const emailKey = $('#emailColumn').value;
    const counts = {};
    state.rows.forEach((r) => { const e = (r[emailKey] || '').toLowerCase(); if (e) counts[e] = (counts[e] || 0) + 1; });

    thead.innerHTML = `<tr><th>#</th>${state.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`;
    const currentRows = new Set((state.recipients[state.previewIndex]?.rows || []).map((r) => r.__row));
    tbody.innerHTML = state.rows.map((r) => {
      const dup = counts[(r[emailKey] || '').toLowerCase()] > 1;
      return `<tr data-row="${r.__row}" class="${dup ? 'dup' : ''} ${currentRows.has(r.__row) ? 'active' : ''}">
        <td class="text-slate-500">${r.__row}</td>
        ${state.keys.map((k) => `<td title="${escapeHtml(r[k])}">${escapeHtml(r[k])}</td>`).join('')}
      </tr>`;
    }).join('');
    $('#tableMeta').textContent = `${state.rows.length} rows · ${state.keys.length} columns`;

    tbody.querySelectorAll('tr').forEach((tr) => tr.addEventListener('click', () => {
      const rowNo = Number(tr.dataset.row);
      const idx = state.recipients.findIndex((rc) => rc.rows.some((x) => x.__row === rowNo));
      if (idx >= 0) setPreviewIndex(idx);
    }));
  }

  /* Sample dataset for testing */
  $('#btnLoadSample').addEventListener('click', () => {
    const header = ['Roll', 'Name', 'Email', 'Team', 'Position'];
    const rows = [
      ['CS101', 'Priya Sharma', 'priya@example.com', 'Team Alpha', 'Winner'],
      ['CS102', 'Rahul Verma', 'leader@example.com', 'Team Beta', 'Runner-up'],
      ['CS103', 'Aman Gupta', 'leader@example.com', 'Team Beta', 'Runner-up'],
      ['CS104', 'Rohit Sen', 'leader@example.com', 'Team Beta', 'Runner-up'],
      ['CS105', 'Ananya Krishnamurthy Iyer', 'ananya@example.com', 'Team Gamma', 'Participant'],
      ['CS106', 'Mohammed Abdul Rahman', 'mohammed@example.com', 'Team Delta', 'Participant'],
      ['CS107', 'Sneha Patel', 'sneha@example.com', 'Team Alpha', 'Winner'],
      ['CS108', 'Sneha Patel', 'sneha@example.com', 'Team Epsilon', 'Volunteer']
    ];
    applyDataset(header, rows, 'sample_participants.csv');
  });

  /* ===========================================================================
     3. DUPLICATE-EMAIL GROUPING
     ---------------------------------------------------------------------------
     A "recipient" is one email to be sent. It carries one or more "certs",
     each cert is a data object used to render a certificate.
       recipient = { id, email, names[], rows[], certs: [{ id, data, label }] }
     Modes:
       separate     -> every row is its own recipient with one cert
       consolidated -> rows with same email -> one recipient, N certs
       combined     -> rows with same email -> one recipient, 1 cert whose
                       name column = "A, B & C"
     =========================================================================== */
  function dupMode() { return $('input[name="dupMode"]:checked').value; }

  function certData(row, extra = {}) {
    const d = { ...row, ...extra };
    const idPrefix = ($('#idPrefix').value || 'CF').trim();
    const nameKey = $('#nameColumn').value;
    const emailKey = $('#emailColumn').value;
    const seed = `${d[nameKey] || ''}|${d[emailKey] || ''}|${d.__row}|${d.__group || ''}`;
    d.certificate_id = `${idPrefix}-${hash(seed)}-${hash(seed.split('').reverse().join('')).slice(0, 4)}`;
    d.qr_code = d.certificate_id;
    d.date = todayStr();
    return d;
  }

  function rebuildRecipients() {
    const mode = dupMode();
    const nameKey = $('#nameColumn').value;
    const emailKey = $('#emailColumn').value;
    const recipients = [];

    if (mode === 'separate' || !state.rows.length) {
      state.rows.forEach((row) => {
        const data = certData(row);
        recipients.push({
          id: `r${row.__row}`,
          email: (row[emailKey] || '').trim(),
          names: [row[nameKey] || ''],
          rows: [row],
          certs: [{ id: `c${row.__row}`, data, label: row[nameKey] || `Row ${row.__row}` }]
        });
      });
    } else {
      const groups = new Map();
      state.rows.forEach((row) => {
        const email = (row[emailKey] || '').trim().toLowerCase();
        const key = email || `__noemail_${row.__row}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      });
      let gi = 0;
      groups.forEach((rows, key) => {
        gi++;
        const email = key.startsWith('__noemail_') ? '' : (rows[0][emailKey] || '').trim();
        const names = rows.map((r) => r[nameKey] || '').filter(Boolean);
        if (mode === 'consolidated') {
          recipients.push({
            id: `g${gi}`,
            email,
            names,
            rows,
            certs: rows.map((row) => ({ id: `c${row.__row}`, data: certData(row), label: row[nameKey] || `Row ${row.__row}` }))
          });
        } else { // combined
          const merged = { ...rows[0], __group: rows.map((r) => r.__row).join('-') };
          merged[nameKey] = joinNames(names, '&');
          // Merge other columns that differ: "Team Beta / Team Gamma"
          state.keys.forEach((k) => {
            if (k === nameKey || k === emailKey) return;
            const vals = [...new Set(rows.map((r) => r[k]).filter(Boolean))];
            if (vals.length > 1) merged[k] = vals.join(' / ');
          });
          recipients.push({
            id: `g${gi}`,
            email,
            names,
            rows,
            certs: [{ id: `cg${gi}`, data: certData(merged), label: merged[nameKey] || `Group ${gi}` }]
          });
        }
      });
    }

    state.recipients = recipients;
    state.previewIndex = clamp(state.previewIndex, 0, Math.max(0, recipients.length - 1));
    renderDupSummary();
  }

  function renderDupSummary() {
    const el = $('#dupSummary');
    const groupMeta = $('#groupMeta');
    if (!state.rows.length) { el.textContent = 'No dataset loaded.'; groupMeta.classList.add('hidden'); return; }
    const emailKey = $('#emailColumn').value;
    const counts = {};
    state.rows.forEach((r) => { const e = (r[emailKey] || '').toLowerCase().trim(); if (e) counts[e] = (counts[e] || 0) + 1; });
    const dupEmails = Object.entries(counts).filter(([, c]) => c > 1);
    const dupRows = dupEmails.reduce((s, [, c]) => s + c, 0);
    const certs = state.recipients.reduce((s, r) => s + r.certs.length, 0);
    const mode = dupMode();
    el.innerHTML = `
      <div class="flex justify-between"><span>Rows</span><strong class="text-white">${state.rows.length}</strong></div>
      <div class="flex justify-between"><span>Duplicate emails</span><strong class="${dupEmails.length ? 'text-amber-300' : 'text-white'}">${dupEmails.length} <span class="font-normal text-slate-500">(${dupRows} rows)</span></strong></div>
      <div class="flex justify-between"><span>Certificates to render</span><strong class="text-white">${certs}</strong></div>
      <div class="flex justify-between"><span>Emails to send</span><strong class="text-brand-300">${state.recipients.filter((r) => r.email).length}</strong></div>
      ${dupEmails.length && mode === 'separate' ? '<p class="mt-1 text-amber-300/90"><i class="fa-solid fa-triangle-exclamation mr-1"></i>Duplicate emails will receive multiple separate messages.</p>' : ''}
    `;
    groupMeta.classList.remove('hidden');
    groupMeta.textContent = `${state.recipients.length} recipient${state.recipients.length === 1 ? '' : 's'} · ${certs} cert${certs === 1 ? '' : 's'}`;
  }

  $$('input[name="dupMode"]').forEach((r) => r.addEventListener('change', () => {
    rebuildRecipients(); renderTable(); renderRowSelect(); render();
  }));
  $('#idPrefix').addEventListener('input', () => { rebuildRecipients(); render(); });

  /* ===========================================================================
     4. FIELD MODEL, CHIPS, DRAG & DROP
     =========================================================================== */
  /**
   * Field = {
   *   id, var, type: 'text'|'qr', x, y,
   *   font, size, color, bold, italic, align, transform, spacing, maxWidth,
   *   shadow: { on, blur, x, y, color },
   *   qr: { size, prefix, dark, light },
   *   overrides: { [certId]: { size?, x?, y? } }
   * }
   */
  function defaultField(varName, x, y) {
    const isQr = varName === 'qr_code';
    const isName = varName === $('#nameColumn').value;
    const w = canvas.width || 1200;
    return {
      id: uid(),
      var: varName,
      type: isQr ? 'qr' : 'text',
      x: Math.round(x), y: Math.round(y),
      font: isName ? 'Great Vibes' : 'Montserrat',
      size: Math.round(isName ? w * 0.06 : w * 0.022),
      color: '#1f2937',
      bold: false, italic: false,
      align: 'center',
      transform: 'none',
      spacing: 0,
      maxWidth: isName ? Math.round(w * 0.7) : 0,
      shadow: { on: false, blur: 4, x: 2, y: 2, color: '#000000' },
      qr: { size: Math.round(w * 0.1), prefix: '', dark: '#111111', light: '#ffffff' },
      overrides: {}
    };
  }

  function renderChips() {
    const c = $('#chipContainer');
    c.innerHTML = '';
    if (!state.keys.length) { c.innerHTML = '<p class="text-xs text-slate-500 italic">Import a dataset to see columns.</p>'; return; }
    state.keys.forEach((k, i) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.draggable = true;
      b.dataset.var = k;
      b.title = `Drag onto canvas: ${state.headers[i]}`;
      b.innerHTML = `<i class="fa-solid fa-plus text-[10px]"></i>${escapeHtml(k)}`;
      c.appendChild(b);
    });
    wireChips();
  }

  function wireChips() {
    $$('.chip[data-var]').forEach((chip) => {
      if (chip.dataset.wired) return;
      chip.dataset.wired = '1';
      chip.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/certiforge-var', chip.dataset.var);
        e.dataTransfer.effectAllowed = 'copy';
      });
      chip.addEventListener('click', () => addField(chip.dataset.var, canvas.width / 2, canvas.height / 2));
    });
  }
  wireChips(); // smart chips exist at load

  function addField(varName, x, y) {
    if (!state.template) { toast('Upload a certificate template first.', 'error'); return; }
    const f = defaultField(varName, x, y);
    state.fields.push(f);
    state.selectedId = f.id;
    renderLayers(); renderProps(); render();
  }

  // Drop onto canvas
  stage.addEventListener('drop', (e) => {
    e.preventDefault();
    stage.classList.remove('dragover');
    const v = e.dataTransfer.getData('text/certiforge-var');
    if (v) {
      const p = canvasPoint(e);
      addField(v, clamp(p.x, 0, canvas.width), clamp(p.y, 0, canvas.height));
      return;
    }
    const file = e.dataTransfer.files?.[0];
    if (file) {
      if (/image/.test(file.type)) loadTemplate(file);
      else if (/\.(xlsx|xls|csv)$/i.test(file.name)) loadDataset(file);
    }
  });

  /* ===========================================================================
     5. CANVAS RENDERING ENGINE
     =========================================================================== */
  function applyTransform(text, t) {
    const s = String(text ?? '');
    switch (t) {
      case 'uppercase': return s.toUpperCase();
      case 'lowercase': return s.toLowerCase();
      case 'capitalize': return s.toLowerCase().replace(/(^|\s|[-'])\S/g, (m) => m.toUpperCase());
      default: return s;
    }
  }

  function fontString(f, size) {
    return `${f.italic ? 'italic ' : ''}${f.bold ? 'bold ' : ''}${size}px "${f.font}"`;
  }

  /** Effective field props for a given cert (applies per-row overrides) */
  function effective(f, certId) {
    const o = (certId && f.overrides[certId]) || {};
    return { ...f, size: o.size ?? f.size, x: o.x ?? f.x, y: o.y ?? f.y, qr: { ...f.qr, size: o.qrSize ?? f.qr.size } };
  }

  /** Measure text with letter spacing */
  function measure(c, text, spacing) {
    const w = c.measureText(text).width;
    return spacing ? w + spacing * Math.max(0, text.length - 1) : w;
  }

  /** Compute size after auto-fit to maxWidth */
  function fittedSize(c, f, text) {
    let size = f.size;
    if (!f.maxWidth || f.maxWidth <= 0) return size;
    c.font = fontString(f, size);
    let w = measure(c, text, f.spacing);
    const min = Math.max(6, Math.round(f.size * 0.3));
    while (w > f.maxWidth && size > min) {
      size = Math.max(min, size - Math.max(1, Math.round(size * 0.04)));
      c.font = fontString(f, size);
      w = measure(c, text, f.spacing);
    }
    return size;
  }

  /** Draw text with letter spacing & alignment */
  function drawText(c, text, x, y, align, spacing) {
    if (!spacing) {
      c.textAlign = align;
      c.fillText(text, x, y);
      return;
    }
    c.textAlign = 'left';
    const total = measure(c, text, spacing);
    let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
    for (const ch of text) {
      c.fillText(ch, cx, y);
      cx += c.measureText(ch).width + spacing;
    }
  }

  /** Resolve the value of a field for a cert data object */
  function valueFor(f, data) {
    if (!data) return `{${f.var}}`;
    const v = data[f.var];
    if (v === undefined || v === null || v === '') return SMART_VARS.includes(f.var) ? '' : `{${f.var}}`;
    return String(v);
  }

  const qrCache = new Map();
  function qrCanvas(text, size, dark, light) {
    const key = `${text}|${size}|${dark}|${light}`;
    if (qrCache.has(key)) return qrCache.get(key);
    if (typeof qrcode === 'undefined') return null;
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const off = document.createElement('canvas');
    off.width = size; off.height = size;
    const oc = off.getContext('2d');
    oc.fillStyle = light; oc.fillRect(0, 0, size, size);
    const margin = Math.max(2, Math.round(size * 0.04));
    const cell = (size - margin * 2) / n;
    oc.fillStyle = dark;
    for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) {
      if (qr.isDark(r, col)) oc.fillRect(Math.floor(margin + col * cell), Math.floor(margin + r * cell), Math.ceil(cell), Math.ceil(cell));
    }
    if (qrCache.size > 500) qrCache.clear();
    qrCache.set(key, off);
    return off;
  }

  /**
   * Draw a complete certificate for `data` on context `c` (canvas-sized).
   * Returns bounding boxes for hit testing when `boxes` provided.
   */
  function drawCertificate(c, data, certId, boxes) {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, c.canvas.width, c.canvas.height);
    if (state.template) c.drawImage(state.template, 0, 0, c.canvas.width, c.canvas.height);

    for (const raw of state.fields) {
      const f = effective(raw, certId);
      let box;
      if (f.type === 'qr') {
        const text = valueFor(f, data);
        const payload = `${f.qr.prefix || ''}${text}`;
        const img = qrCanvas(payload, f.qr.size, f.qr.dark, f.qr.light);
        const x0 = f.align === 'center' ? f.x - f.qr.size / 2 : f.align === 'right' ? f.x - f.qr.size : f.x;
        const y0 = f.y - f.qr.size / 2;
        if (img) c.drawImage(img, x0, y0);
        box = { x: x0, y: y0, w: f.qr.size, h: f.qr.size };
      } else {
        const text = applyTransform(valueFor(f, data), f.transform);
        const size = fittedSize(c, f, text);
        c.font = fontString(f, size);
        c.textBaseline = 'middle';
        c.fillStyle = f.color;
        if (f.shadow.on) {
          c.shadowColor = f.shadow.color; c.shadowBlur = f.shadow.blur; c.shadowOffsetX = f.shadow.x; c.shadowOffsetY = f.shadow.y;
        } else {
          c.shadowColor = 'transparent'; c.shadowBlur = 0; c.shadowOffsetX = 0; c.shadowOffsetY = 0;
        }
        drawText(c, text, f.x, f.y, f.align, f.spacing);
        c.shadowColor = 'transparent'; c.shadowBlur = 0; c.shadowOffsetX = 0; c.shadowOffsetY = 0;
        const w = measure(c, text, f.spacing);
        const h = size * 1.2;
        const x0 = f.align === 'center' ? f.x - w / 2 : f.align === 'right' ? f.x - w : f.x;
        box = { x: x0, y: f.y - h / 2, w: Math.max(w, 20), h, fitted: size !== f.size, size };
      }
      if (boxes) boxes.set(raw.id, box);
    }
  }

  const hitBoxes = new Map();
  function currentCert() {
    const r = state.recipients[state.previewIndex];
    return r ? r.certs[0] : null;
  }

  /** Render the on-screen canvas with guides */
  function render() {
    if (!state.template) return;
    const cert = currentCert();
    hitBoxes.clear();
    drawCertificate(ctx, cert?.data || null, cert?.id || null, hitBoxes);

    if (state.guides) {
      for (const f of state.fields) {
        const b = hitBoxes.get(f.id);
        if (!b) continue;
        const sel = f.id === state.selectedId;
        const eff = effective(f, cert?.id);
        ctx.save();
        ctx.setLineDash(sel ? [] : [6, 4]);
        ctx.lineWidth = Math.max(1, canvas.width / 900);
        ctx.strokeStyle = sel ? '#8b5cf6' : 'rgba(139,92,246,0.55)';
        ctx.strokeRect(b.x - 6, b.y - 4, b.w + 12, b.h + 8);
        // anchor dot
        ctx.fillStyle = sel ? '#06b6d4' : 'rgba(6,182,212,.7)';
        ctx.beginPath(); ctx.arc(eff.x, eff.y, Math.max(3, canvas.width / 300), 0, Math.PI * 2); ctx.fill();
        // label
        const label = `{${f.var}}${b.fitted ? ` ↓${b.size}px` : ''}${cert && f.overrides[cert.id] ? ' •override' : ''}`;
        const fs = Math.max(11, canvas.width / 90);
        ctx.font = `600 ${fs}px Inter, sans-serif`;
        ctx.textBaseline = 'bottom'; ctx.textAlign = 'left';
        const lw = ctx.measureText(label).width + 10;
        ctx.fillStyle = sel ? '#8b5cf6' : 'rgba(17,24,39,.85)';
        ctx.fillRect(b.x - 6, b.y - 4 - fs - 6, lw, fs + 6);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, b.x - 1, b.y - 6);
        // max width guide for selected
        if (sel && eff.maxWidth > 0 && f.type === 'text') {
          ctx.setLineDash([3, 3]); ctx.strokeStyle = 'rgba(245,158,11,.8)';
          const mx = eff.align === 'center' ? eff.x - eff.maxWidth / 2 : eff.align === 'right' ? eff.x - eff.maxWidth : eff.x;
          ctx.strokeRect(mx, b.y - 10, eff.maxWidth, b.h + 20);
        }
        ctx.restore();
      }
    }
  }

  /** Render a clean (no guides) certificate to a PNG Blob at full resolution */
  async function renderCertBlob(cert) {
    const off = document.createElement('canvas');
    off.width = canvas.width; off.height = canvas.height;
    const oc = off.getContext('2d');
    drawCertificate(oc, cert.data, cert.id, null);
    return new Promise((resolve) => off.toBlob(resolve, 'image/png'));
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1]);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  /* ===========================================================================
     6. CANVAS INTERACTION
     =========================================================================== */
  function canvasPoint(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height)
    };
  }

  function hitTest(p) {
    // Topmost first
    for (let i = state.fields.length - 1; i >= 0; i--) {
      const f = state.fields[i];
      const b = hitBoxes.get(f.id);
      if (b && p.x >= b.x - 8 && p.x <= b.x + b.w + 8 && p.y >= b.y - 6 && p.y <= b.y + b.h + 6) return f;
    }
    return null;
  }

  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    const p = canvasPoint(e);
    const f = hitTest(p);
    state.selectedId = f ? f.id : null;
    if (f) {
      const cert = currentCert();
      const eff = effective(f, cert?.id);
      drag = { id: f.id, dx: eff.x - p.x, dy: eff.y - p.y, moved: false };
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add('grabbing');
    }
    renderLayers(); renderProps(); render();
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = canvasPoint(e);
    if (drag) {
      const f = state.fields.find((x) => x.id === drag.id);
      if (!f) return;
      const nx = Math.round(clamp(p.x + drag.dx, 0, canvas.width));
      const ny = Math.round(clamp(p.y + drag.dy, 0, canvas.height));
      setFieldPos(f, nx, ny);
      drag.moved = true;
      render(); syncPosInputs(f);
      return;
    }
    canvas.classList.toggle('hover', !!hitTest(p));
  });

  const endDrag = (e) => {
    if (!drag) return;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    drag = null;
    canvas.classList.remove('grabbing');
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  /** Set position, honouring override mode */
  function setFieldPos(f, x, y) {
    const cert = currentCert();
    if (state.overrideMode && cert) {
      f.overrides[cert.id] = { ...(f.overrides[cert.id] || {}), x, y };
    } else {
      f.x = x; f.y = y;
    }
  }
  function setFieldSize(f, size) {
    const cert = currentCert();
    if (state.overrideMode && cert) {
      f.overrides[cert.id] = { ...(f.overrides[cert.id] || {}), size };
    } else {
      f.size = size;
    }
  }

  // Keyboard: nudge / delete
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (['input', 'select', 'textarea'].includes(tag) || e.target.isContentEditable) return;
    const f = state.fields.find((x) => x.id === state.selectedId);
    if (!f) return;
    const step = e.shiftKey ? 10 : 1;
    const cert = currentCert();
    const eff = effective(f, cert?.id);
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft': setFieldPos(f, eff.x - step, eff.y); break;
      case 'ArrowRight': setFieldPos(f, eff.x + step, eff.y); break;
      case 'ArrowUp': setFieldPos(f, eff.x, eff.y - step); break;
      case 'ArrowDown': setFieldPos(f, eff.x, eff.y + step); break;
      case 'Delete': case 'Backspace': deleteField(f.id); return;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); render(); syncPosInputs(f); }
  });

  function deleteField(id) {
    state.fields = state.fields.filter((f) => f.id !== id);
    if (state.selectedId === id) state.selectedId = null;
    renderLayers(); renderProps(); render();
  }

  // Zoom
  function setZoom(z) {
    state.zoom = clamp(z, 0.1, 3);
    canvas.style.width = `${canvas.width * state.zoom}px`;
    canvas.style.height = `${canvas.height * state.zoom}px`;
    $('#zoomLabel').textContent = `${Math.round(state.zoom * 100)}%`;
  }
  function fitZoom() {
    const avail = stage.clientWidth - 40;
    const availH = Math.max(300, stage.clientHeight - 40 || window.innerHeight * 0.6);
    setZoom(Math.min(avail / canvas.width, availH / canvas.height, 1));
  }
  $('#btnZoomIn').addEventListener('click', () => setZoom(state.zoom + 0.1));
  $('#btnZoomOut').addEventListener('click', () => setZoom(state.zoom - 0.1));
  $('#btnZoomFit').addEventListener('click', fitZoom);
  window.addEventListener('resize', () => { if (state.template) fitZoom(); });
  $('#toggleGuides').addEventListener('change', (e) => { state.guides = e.target.checked; render(); });

  /* ===========================================================================
     7. PROPERTIES PANEL
     =========================================================================== */
  const P = {
    font: $('#pFont'), size: $('#pSize'), color: $('#pColor'), colorHex: $('#pColorHex'),
    bold: $('#pBold'), italic: $('#pItalic'), spacing: $('#pSpacing'), maxWidth: $('#pMaxWidth'),
    shadow: $('#pShadow'), shBlur: $('#pShBlur'), shColor: $('#pShColor'), shX: $('#pShX'), shY: $('#pShY'),
    x: $('#pX'), y: $('#pY'), override: $('#pOverride'),
    qrSize: $('#pQrSize'), qrSizeVal: $('#pQrSizeVal'), qrPrefix: $('#pQrPrefix'), qrDark: $('#pQrDark'), qrLight: $('#pQrLight')
  };

  function selectedField() { return state.fields.find((f) => f.id === state.selectedId) || null; }

  function renderLayers() {
    const ul = $('#layerList');
    if (!state.fields.length) { ul.innerHTML = '<li class="text-xs text-slate-500 italic">No fields yet.</li>'; return; }
    ul.innerHTML = state.fields.map((f) => `
      <li class="layer ${f.id === state.selectedId ? 'active' : ''}" data-id="${f.id}">
        <i class="fa-solid ${f.type === 'qr' ? 'fa-qrcode text-accent-400' : 'fa-font text-brand-400'}"></i>
        <span class="truncate">{${escapeHtml(f.var)}}</span>
        ${Object.keys(f.overrides).length ? `<span class="rounded bg-amber-500/20 px-1 text-[10px] text-amber-300" title="Per-row overrides">${Object.keys(f.overrides).length}</span>` : ''}
        <button class="layer-del" title="Remove" aria-label="Remove field"><i class="fa-solid fa-xmark"></i></button>
      </li>`).join('');
    ul.querySelectorAll('.layer').forEach((li) => {
      li.addEventListener('click', (e) => {
        if (e.target.closest('.layer-del')) { deleteField(li.dataset.id); return; }
        state.selectedId = li.dataset.id; renderLayers(); renderProps(); render();
      });
    });
  }

  function syncPosInputs(f) {
    const cert = currentCert();
    const eff = effective(f, cert?.id);
    P.x.value = eff.x; P.y.value = eff.y;
    renderOverrideInfo(f);
  }

  function renderOverrideInfo(f) {
    const cert = currentCert();
    $('#overrideRowLabel').textContent = cert ? cert.label : '—';
    const list = $('#overrideList');
    const ids = Object.keys(f.overrides);
    if (!ids.length) { list.innerHTML = ''; return; }
    list.innerHTML = `${ids.length} row override${ids.length > 1 ? 's' : ''} on this field.
      ${cert && f.overrides[cert.id] ? `<button id="btnClearOverride" class="ml-1 underline hover:text-white">Clear for this row</button>` : ''}
      <button id="btnClearAllOverrides" class="ml-1 underline hover:text-white">Clear all</button>`;
    $('#btnClearOverride')?.addEventListener('click', () => { delete f.overrides[cert.id]; renderProps(); renderLayers(); render(); });
    $('#btnClearAllOverrides')?.addEventListener('click', () => { f.overrides = {}; renderProps(); renderLayers(); render(); });
  }

  function renderProps() {
    const f = selectedField();
    $('#propsTarget').textContent = f ? `{${f.var}}` : 'none';
    $('#propsEmpty').classList.toggle('hidden', !!f);
    $('#propsForm').classList.toggle('hidden', !f);
    if (!f) return;

    const cert = currentCert();
    const eff = effective(f, cert?.id);
    const isQr = f.type === 'qr';
    $('#qrProps').classList.toggle('hidden', !isQr);
    $('#textProps').classList.toggle('hidden', isQr);

    P.font.value = f.font;
    P.size.value = eff.size;
    P.color.value = f.color; P.colorHex.value = f.color.toUpperCase();
    P.bold.classList.toggle('active', f.bold);
    P.italic.classList.toggle('active', f.italic);
    $$('#pAlign .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.align === f.align));
    $$('#pTransform .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.transform === f.transform));
    P.spacing.value = f.spacing; P.maxWidth.value = f.maxWidth || 0;
    P.shadow.checked = f.shadow.on; P.shBlur.value = f.shadow.blur; P.shColor.value = f.shadow.color; P.shX.value = f.shadow.x; P.shY.value = f.shadow.y;
    $('#shadowControls').classList.toggle('opacity-50', !f.shadow.on);
    P.x.value = eff.x; P.y.value = eff.y;
    P.override.checked = state.overrideMode;
    P.qrSize.value = eff.qr.size; P.qrSizeVal.textContent = `${eff.qr.size}px`;
    P.qrPrefix.value = f.qr.prefix; P.qrDark.value = f.qr.dark; P.qrLight.value = f.qr.light;
    renderOverrideInfo(f);
  }

  /** Generic binder: update field prop, re-render */
  function bind(el, event, fn) { el.addEventListener(event, () => { const f = selectedField(); if (!f) return; fn(f); render(); renderLayers(); }); }

  bind(P.font, 'change', (f) => { f.font = P.font.value; });
  bind(P.size, 'input', (f) => { const v = clamp(Number(P.size.value) || 6, 6, 600); setFieldSize(f, v); renderOverrideInfo(f); });
  bind(P.color, 'input', (f) => { f.color = P.color.value; P.colorHex.value = f.color.toUpperCase(); });
  bind(P.colorHex, 'input', (f) => { let v = P.colorHex.value.trim(); if (!v.startsWith('#')) v = `#${v}`; if (/^#[0-9a-f]{6}$/i.test(v)) { f.color = v; P.color.value = v; } });
  bind(P.bold, 'click', (f) => { f.bold = !f.bold; P.bold.classList.toggle('active', f.bold); });
  bind(P.italic, 'click', (f) => { f.italic = !f.italic; P.italic.classList.toggle('active', f.italic); });
  $$('#pAlign .seg-btn').forEach((b) => bind(b, 'click', (f) => { f.align = b.dataset.align; renderProps(); }));
  $$('#pTransform .seg-btn').forEach((b) => bind(b, 'click', (f) => { f.transform = b.dataset.transform; renderProps(); }));
  bind(P.spacing, 'input', (f) => { f.spacing = Number(P.spacing.value) || 0; });
  bind(P.maxWidth, 'input', (f) => { f.maxWidth = Math.max(0, Number(P.maxWidth.value) || 0); });
  bind(P.shadow, 'change', (f) => { f.shadow.on = P.shadow.checked; $('#shadowControls').classList.toggle('opacity-50', !f.shadow.on); });
  bind(P.shBlur, 'input', (f) => { f.shadow.blur = Number(P.shBlur.value) || 0; });
  bind(P.shColor, 'input', (f) => { f.shadow.color = P.shColor.value; });
  bind(P.shX, 'input', (f) => { f.shadow.x = Number(P.shX.value) || 0; });
  bind(P.shY, 'input', (f) => { f.shadow.y = Number(P.shY.value) || 0; });
  bind(P.x, 'input', (f) => { const e = effective(f, currentCert()?.id); setFieldPos(f, Number(P.x.value) || 0, e.y); renderOverrideInfo(f); });
  bind(P.y, 'input', (f) => { const e = effective(f, currentCert()?.id); setFieldPos(f, e.x, Number(P.y.value) || 0); renderOverrideInfo(f); });
  bind(P.qrSize, 'input', (f) => {
    const v = Number(P.qrSize.value); P.qrSizeVal.textContent = `${v}px`;
    const cert = currentCert();
    if (state.overrideMode && cert) f.overrides[cert.id] = { ...(f.overrides[cert.id] || {}), qrSize: v }; else f.qr.size = v;
  });
  bind(P.qrPrefix, 'input', (f) => { f.qr.prefix = P.qrPrefix.value; });
  bind(P.qrDark, 'input', (f) => { f.qr.dark = P.qrDark.value; });
  bind(P.qrLight, 'input', (f) => { f.qr.light = P.qrLight.value; });

  P.override.addEventListener('change', () => {
    state.overrideMode = P.override.checked;
    if (state.overrideMode && !currentCert()) { toast('Load a dataset to use per-row overrides.', 'error'); state.overrideMode = false; P.override.checked = false; }
    else toast(state.overrideMode ? 'Override mode ON: size/position changes affect only the previewed row.' : 'Override mode OFF.', 'info');
  });

  $('#btnDeleteField').addEventListener('click', () => { if (state.selectedId) deleteField(state.selectedId); });
  $('#btnDuplicateField').addEventListener('click', () => {
    const f = selectedField(); if (!f) return;
    const copy = JSON.parse(JSON.stringify(f)); copy.id = uid(); copy.y += Math.round(f.size * 1.3); copy.overrides = {};
    state.fields.push(copy); state.selectedId = copy.id; renderLayers(); renderProps(); render();
  });

  /* ===========================================================================
     8. ROW NAVIGATION
     =========================================================================== */
  function renderRowSelect() {
    const sel = $('#rowSelect');
    sel.innerHTML = state.recipients.map((r, i) => {
      const label = r.certs.length > 1 ? `${joinNames(r.names)} (${r.certs.length} certs)` : r.certs[0].label;
      return `<option value="${i}">${escapeHtml(label.length > 48 ? `${label.slice(0, 46)}…` : label)}</option>`;
    }).join('');
    sel.value = String(state.previewIndex);
    $('#rowCounter').textContent = `${state.recipients.length ? state.previewIndex + 1 : 0} / ${state.recipients.length}`;
    const f = selectedField(); if (f) renderProps();
  }
  function setPreviewIndex(i) {
    if (!state.recipients.length) return;
    state.previewIndex = (i + state.recipients.length) % state.recipients.length;
    renderRowSelect(); render(); renderTable();
    const f = selectedField(); if (f) renderProps();
  }
  $('#btnPrevRow').addEventListener('click', () => setPreviewIndex(state.previewIndex - 1));
  $('#btnNextRow').addEventListener('click', () => setPreviewIndex(state.previewIndex + 1));
  $('#rowSelect').addEventListener('change', (e) => setPreviewIndex(Number(e.target.value)));

  /* ===========================================================================
     9. EXPORT (PNG / ZIP)
     =========================================================================== */
  function fileNameFor(cert, fallbackIdx) {
    const pattern = $('#fileNamePattern').value || '{{name}}_Certificate';
    let name = pattern.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, k) => {
      const v = cert.data[k.toLowerCase()];
      return v ? String(v) : '';
    });
    name = sanitizeFile(name.replace(/^_+|_+$/g, ''));
    if (!name || name === 'Certificate') name = `Certificate_${fallbackIdx + 1}`;
    return `${name}.png`;
  }

  function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function requireReady() {
    if (!state.template) { toast('Upload a certificate template first.', 'error'); return false; }
    if (!state.recipients.length) { toast('Import a dataset first.', 'error'); return false; }
    if (!state.fields.length) { toast('Add at least one variable field to the canvas.', 'error'); return false; }
    return true;
  }

  $('#btnDownloadPreview').addEventListener('click', async () => {
    if (!requireReady()) return;
    await ensureFonts();
    const cert = currentCert();
    const blob = await renderCertBlob(cert);
    downloadBlob(blob, fileNameFor(cert, state.previewIndex));
    toast('Preview PNG downloaded.', 'success');
  });

  $('#btnDownloadZip').addEventListener('click', async () => {
    if (!requireReady()) return;
    if (typeof JSZip === 'undefined') { toast('JSZip failed to load.', 'error'); return; }
    await ensureFonts();
    const certs = state.recipients.flatMap((r) => r.certs);
    openProgress('Rendering certificates', certs.length);
    $('#btnRetryFailed').classList.add('hidden');
    const zip = new JSZip();
    const used = new Set();
    for (let i = 0; i < certs.length; i++) {
      const cert = certs[i];
      let name = fileNameFor(cert, i);
      if (used.has(name)) name = name.replace(/\.png$/, `_${i + 1}.png`);
      used.add(name);
      updateProgressRow(cert.id, cert.label, 'sending', 'Rendering');
      const blob = await renderCertBlob(cert);
      zip.file(name, blob);
      updateProgressRow(cert.id, cert.label, 'success', name);
      setProgress(i + 1, certs.length, `Rendered ${i + 1} / ${certs.length}`);
      if (i % 3 === 0) await sleep(0);
    }
    setProgress(certs.length, certs.length, 'Compressing ZIP…');
    const out = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    downloadBlob(out, `CertiForge_Certificates_${new Date().toISOString().slice(0, 10)}.zip`);
    setProgress(certs.length, certs.length, 'Done');
    toast(`ZIP with ${certs.length} certificates downloaded.`, 'success');
  });

  /* ===========================================================================
     10. SMTP MODAL
     =========================================================================== */
  const S = { host: $('#smtpHost'), port: $('#smtpPort'), user: $('#smtpUser'), pass: $('#smtpPass'), from: $('#smtpFrom'), secure: $('#smtpSecure'), remember: $('#smtpRemember') };

  function readSmtpForm() {
    return {
      host: S.host.value.trim(), port: Number(S.port.value) || 465, user: S.user.value.trim(), pass: S.pass.value,
      fromName: S.from.value.trim() || 'CertiForge', secure: S.secure.checked
    };
  }
  function smtpStatus(msg, ok) {
    const el = $('#smtpStatus');
    el.classList.remove('hidden');
    el.className = `rounded-lg px-3 py-2 text-xs ${ok === null ? 'bg-ink-700 text-slate-300' : ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'}`;
    el.innerHTML = msg;
  }
  function loadSmtpFromStorage() {
    try {
      const saved = JSON.parse(localStorage.getItem('certiforge.smtp') || 'null');
      if (saved) {
        state.smtp = saved;
        S.host.value = saved.host || ''; S.port.value = saved.port || 465; S.user.value = saved.user || '';
        S.pass.value = saved.pass || ''; S.from.value = saved.fromName || ''; S.secure.checked = saved.secure !== false; S.remember.checked = true;
      }
    } catch (_) { /* ignore */ }
  }
  loadSmtpFromStorage();

  S.port.addEventListener('change', () => { S.secure.checked = Number(S.port.value) === 465; });
  $('#togglePass').addEventListener('click', () => {
    const show = S.pass.type === 'password';
    S.pass.type = show ? 'text' : 'password';
    $('#togglePass i').className = show ? 'fa-regular fa-eye-slash' : 'fa-regular fa-eye';
  });
  $('#btnSmtp').addEventListener('click', () => { $('#smtpStatus').classList.add('hidden'); openModal('smtpModal'); });

  $('#btnTestSmtp').addEventListener('click', async () => {
    const cfg = readSmtpForm();
    if (!cfg.host || !cfg.user || !cfg.pass) { smtpStatus('Please fill host, username and password.', false); return; }
    const btn = $('#btnTestSmtp'); btn.disabled = true;
    smtpStatus('<i class="fa-solid fa-spinner spin mr-1"></i>Testing connection…', null);
    try {
      const res = await fetch('/api/test-smtp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) smtpStatus(`<i class="fa-solid fa-circle-check mr-1"></i>${escapeHtml(json.message)}`, true);
      else smtpStatus(`<i class="fa-solid fa-circle-xmark mr-1"></i>${escapeHtml(json.message || `HTTP ${res.status}`)}`, false);
    } catch (err) {
      smtpStatus(`<i class="fa-solid fa-circle-xmark mr-1"></i>Cannot reach backend. Is <code>npm start</code> running on port 3001? (${escapeHtml(err.message)})`, false);
    } finally { btn.disabled = false; }
  });

  $('#btnSaveSmtp').addEventListener('click', () => {
    const cfg = readSmtpForm();
    if (!cfg.host || !cfg.user || !cfg.pass) { smtpStatus('Please fill host, username and password.', false); return; }
    state.smtp = cfg;
    if (S.remember.checked) localStorage.setItem('certiforge.smtp', JSON.stringify(cfg)); else localStorage.removeItem('certiforge.smtp');
    closeModal('smtpModal');
    toast('SMTP settings saved.', 'success');
  });

  // Server status check
  (async () => {
    const pill = $('#serverStatus'); pill.classList.remove('hidden'); pill.classList.add('inline-flex');
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      const ok = r.ok && (await r.json()).ok;
      $('#serverDot').className = `h-2 w-2 rounded-full ${ok ? 'bg-emerald-400' : 'bg-rose-400'}`;
      $('#serverText').textContent = ok ? 'Backend online' : 'Backend error';
    } catch (_) {
      $('#serverDot').className = 'h-2 w-2 rounded-full bg-amber-400';
      $('#serverText').textContent = 'Backend offline (export still works)';
    }
  })();

  /* ===========================================================================
     11. EMAIL COMPOSER + SENDING
     =========================================================================== */
  const body = $('#emailBody');
  const DEFAULT_BODY = `<p>Hi {{all_names}},</p>
<p>Congratulations! Please find your certificate{{plural}} attached to this email.</p>
<p>Certificate ID: <b>{{certificate_id}}</b></p>
<p>Best regards,<br>The Organizing Team</p>`;
  body.innerHTML = localStorage.getItem('certiforge.body') || DEFAULT_BODY;
  $('#emailSubject').value = localStorage.getItem('certiforge.subject') || $('#emailSubject').value;

  // Rich text toolbar
  $$('#rteToolbar .rte-btn').forEach((b) => b.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const cmd = b.dataset.cmd;
    if (cmd === 'createLink') { const url = prompt('Link URL:', 'https://'); if (url) document.execCommand(cmd, false, url); }
    else document.execCommand(cmd, false, null);
    body.focus(); updateComposePreview();
  }));

  // Track caret to insert chips at cursor
  let savedRange = null;
  const saveRange = () => { const s = window.getSelection(); if (s.rangeCount && body.contains(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange(); };
  body.addEventListener('keyup', saveRange); body.addEventListener('mouseup', saveRange); body.addEventListener('focus', saveRange);
  body.addEventListener('input', () => { saveRange(); updateComposePreview(); });
  $('#emailSubject').addEventListener('input', updateComposePreview);

  let lastFocus = 'body';
  $('#emailSubject').addEventListener('focus', () => { lastFocus = 'subject'; });
  body.addEventListener('focus', () => { lastFocus = 'body'; });

  function insertPlaceholder(token) {
    if (lastFocus === 'subject') {
      const inp = $('#emailSubject');
      const s = inp.selectionStart ?? inp.value.length, e = inp.selectionEnd ?? s;
      inp.value = inp.value.slice(0, s) + token + inp.value.slice(e);
      inp.selectionStart = inp.selectionEnd = s + token.length; inp.focus();
    } else {
      body.focus();
      const sel = window.getSelection();
      if (savedRange) { sel.removeAllRanges(); sel.addRange(savedRange); }
      const range = sel.rangeCount ? sel.getRangeAt(0) : null;
      if (range && body.contains(range.commonAncestorContainer)) {
        range.deleteContents();
        const node = document.createTextNode(token);
        range.insertNode(node);
        range.setStartAfter(node); range.collapse(true);
        sel.removeAllRanges(); sel.addRange(range);
      } else {
        body.appendChild(document.createTextNode(token));
      }
      saveRange();
    }
    updateComposePreview();
  }

  function renderEmailChips() {
    const vars = ['all_names', 'count', 'certificate_id', ...state.keys, 'date'];
    $('#emailChips').innerHTML = [...new Set(vars)].map((v) => `<button type="button" class="chip chip-email" data-token="{{${v}}}">{{${escapeHtml(v)}}}</button>`).join('');
    $$('#emailChips .chip').forEach((c) => c.addEventListener('mousedown', (e) => { e.preventDefault(); insertPlaceholder(c.dataset.token); }));
  }

  /** Build the variable map for a recipient (merges all cert data) */
  function recipientVars(r) {
    const vars = {};
    // Column values: join unique values across certs
    const allKeys = new Set([...state.keys, ...SMART_VARS]);
    allKeys.forEach((k) => {
      const vals = [...new Set(r.certs.map((c) => c.data[k]).filter((v) => v !== undefined && v !== ''))];
      vars[k] = vals.join(', ');
    });
    const nameKey = $('#nameColumn').value;
    const firstNames = r.certs.length > 1 ? r.names : [r.certs[0].data[nameKey] || r.names[0] || ''];
    vars.all_names = joinNames(firstNames, 'and');
    vars.name = r.certs.length > 1 ? vars.all_names : (r.certs[0].data[nameKey] ?? vars.name ?? '');
    vars.email = r.email;
    vars.count = String(r.certs.length);
    vars.plural = r.certs.length > 1 ? 's' : '';
    return vars;
  }

  function fillTemplate(tpl, vars) {
    return String(tpl).replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, k) => {
      const v = vars[k.toLowerCase()];
      return v === undefined ? '' : escapeHtml(v);
    });
  }
  function fillSubject(tpl, vars) {
    return String(tpl).replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, k) => vars[k.toLowerCase()] ?? '');
  }

  function updateComposePreview() {
    const r = state.recipients.find((x) => x.email) || state.recipients[0];
    const vars = r ? recipientVars(r) : { all_names: 'Priya, Rahul and Aman', name: 'Priya', email: 'priya@example.com', count: '3', plural: 's', certificate_id: 'CF-XXXXXXX' };
    $('#previewSubject').textContent = fillSubject($('#emailSubject').value, vars);
    $('#previewBody').innerHTML = fillTemplate(body.innerHTML, vars);
    const emails = state.recipients.filter((x) => x.email).length;
    const certs = state.recipients.reduce((s, x) => s + x.certs.length, 0);
    $('#composePlan').textContent = state.recipients.length ? `${emails} email${emails === 1 ? '' : 's'} · ${certs} attachment${certs === 1 ? '' : 's'} · mode: ${dupMode()}` : '';
    $('#composeSmtpState').innerHTML = state.smtp
      ? `<i class="fa-solid fa-circle-check text-emerald-400 mr-1"></i>SMTP: ${escapeHtml(state.smtp.user)} @ ${escapeHtml(state.smtp.host)}`
      : '<i class="fa-solid fa-triangle-exclamation text-amber-400 mr-1"></i>SMTP not configured';
  }

  $('#btnCompose').addEventListener('click', () => {
    if (!requireReady()) return;
    renderEmailChips(); updateComposePreview(); openModal('composeModal');
  });

  /* ---- Progress UI ---- */
  function openProgress(title, total) {
    $('#progressHeading').textContent = title;
    $('#progressList').innerHTML = '';
    setProgress(0, total, 'Preparing…');
    $('#statSuccess').textContent = '0'; $('#statFailed').textContent = '0'; $('#statPending').textContent = String(total);
    openModal('progressModal');
  }
  function setProgress(done, total, label) {
    $('#progressCount').textContent = `${done} / ${total}`;
    $('#progressBar').style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
    if (label) $('#progressLabel').textContent = label;
  }
  function updateProgressRow(id, label, status, note) {
    const ul = $('#progressList');
    let li = ul.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!li) { li = document.createElement('li'); li.dataset.id = id; ul.appendChild(li); }
    const icon = { pending: 'fa-regular fa-clock', sending: 'fa-solid fa-spinner spin', success: 'fa-solid fa-circle-check', failed: 'fa-solid fa-circle-xmark' }[status];
    const word = { pending: 'Pending', sending: 'Sending', success: 'Success', failed: 'Failed' }[status];
    li.className = `plog ${status}`;
    li.innerHTML = `<span class="truncate">${escapeHtml(label)}</span>
      ${status === 'failed' && note ? `<span class="plog-err truncate" title="${escapeHtml(note)}">${escapeHtml(note)}</span>` : ''}
      <span class="plog-status"><i class="${icon}"></i>${status === 'success' && note && !/^Success/.test(note) ? escapeHtml(note.length > 28 ? `${note.slice(0, 26)}…` : note) : word}</span>`;
    if (status === 'sending') li.scrollIntoView({ block: 'nearest' });
  }
  function refreshStats(results, total) {
    const s = [...results.values()].filter((r) => r.status === 'success').length;
    const f = [...results.values()].filter((r) => r.status === 'failed').length;
    $('#statSuccess').textContent = String(s); $('#statFailed').textContent = String(f); $('#statPending').textContent = String(Math.max(0, total - s - f));
    $('#btnRetryFailed').classList.toggle('hidden', f === 0);
  }

  /* ---- Build + send ---- */
  async function buildEmailPayload(r, subjectTpl, bodyTpl) {
    const vars = recipientVars(r);
    const attachments = [];
    for (let i = 0; i < r.certs.length; i++) {
      const cert = r.certs[i];
      const blob = await renderCertBlob(cert);
      attachments.push({ filename: fileNameFor(cert, i), content: await blobToBase64(blob), contentType: 'image/png' });
    }
    return { id: r.id, to: r.email, subject: fillSubject(subjectTpl, vars), html: fillTemplate(bodyTpl, vars), attachments };
  }

  async function sendRecipients(list, { isRetry = false } = {}) {
    if (!state.smtp) { toast('Configure SMTP settings first.', 'error'); openModal('smtpModal'); return; }
    const subjectTpl = $('#emailSubject').value;
    const bodyTpl = body.innerHTML;
    localStorage.setItem('certiforge.subject', subjectTpl);
    localStorage.setItem('certiforge.body', bodyTpl);
    const delayMs = Math.max(0, Number($('#sendDelay').value) || 0);

    await ensureFonts();
    closeModal('composeModal');
    if (!isRetry) { state.sendResults = new Map(); openProgress('Sending emails', list.length); }
    else { $('#progressHeading').textContent = 'Retrying failed emails'; }
    $('#btnRetryFailed').classList.add('hidden');
    $('#btnDoneProgress').disabled = true; $('#btnCloseProgress').classList.add('hidden');

    const total = isRetry ? state.sendQueue.length : list.length;
    list.forEach((r) => updateProgressRow(r.id, `${joinNames(r.names)} <${r.email}>`, 'pending'));

    let done = isRetry ? total - list.length : 0;
    for (const r of list) {
      const label = `${joinNames(r.names)} <${r.email}>`;
      updateProgressRow(r.id, label, 'sending', `Rendering ${r.certs.length} cert${r.certs.length > 1 ? 's' : ''}`);
      setProgress(done, total, `Sending to ${r.email}…`);
      let result;
      try {
        const payload = await buildEmailPayload(r, subjectTpl, bodyTpl);
        const res = await fetch('/api/send-emails', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ smtp: state.smtp, delayMs: 0, emails: [payload] })
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.ok) throw new Error(json.message || `HTTP ${res.status}`);
        result = json.results?.[0] || { status: 'failed', error: 'No result returned' };
      } catch (err) {
        result = { status: 'failed', error: err.message || 'Network error' };
      }
      state.sendResults.set(r.id, result);
      updateProgressRow(r.id, label, result.status, result.status === 'success' ? `${r.certs.length} attached` : result.error);
      done++;
      setProgress(done, total, `Sent ${[...state.sendResults.values()].filter((x) => x.status === 'success').length} / ${total}`);
      refreshStats(state.sendResults, total);
      if (delayMs && r !== list[list.length - 1]) await sleep(delayMs);
    }

    const failed = [...state.sendResults.values()].filter((x) => x.status === 'failed').length;
    setProgress(done, total, failed ? `Finished with ${failed} failure${failed > 1 ? 's' : ''}` : 'All emails sent');
    $('#btnDoneProgress').disabled = false; $('#btnCloseProgress').classList.remove('hidden');
    toast(failed ? `${failed} email(s) failed. Use "Retry Failed Emails".` : 'All emails sent successfully!', failed ? 'error' : 'success');
  }

  $('#btnSendAll').addEventListener('click', async () => {
    if (!state.smtp) { toast('Configure SMTP settings first.', 'error'); openModal('smtpModal'); return; }
    let list = state.recipients.filter((r) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email));
    const skipped = state.recipients.length - list.length;
    if (!list.length) { toast('No valid email addresses found in the selected Email column.', 'error'); return; }
    if ($('#sendOnlyFirst').checked) list = list.slice(0, 1);
    if (skipped) toast(`${skipped} row(s) skipped due to missing/invalid email.`, 'info');
    if (!confirm(`Send ${list.length} email(s) with ${list.reduce((s, r) => s + r.certs.length, 0)} certificate attachment(s)?`)) return;
    state.sendQueue = list;
    await sendRecipients(list);
  });

  $('#btnRetryFailed').addEventListener('click', async () => {
    const failed = state.sendQueue.filter((r) => state.sendResults.get(r.id)?.status === 'failed');
    if (!failed.length) return;
    await sendRecipients(failed, { isRetry: true });
  });

  /* ===========================================================================
     INIT
     =========================================================================== */
  ensureFonts().then(() => { if (state.template) render(); });
  renderRowSelect();
  renderChips();

  /* ---- Demo mode: open index.html?demo=1 to auto-load a generated template + sample data ---- */
  function buildDemoTemplate() {
    const W = 1600, H = 1131;
    const off = document.createElement('canvas'); off.width = W; off.height = H;
    const c = off.getContext('2d');
    const g = c.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#fdfbf7'); g.addColorStop(1, '#f3ede2');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    c.strokeStyle = '#b08d57'; c.lineWidth = 14; c.strokeRect(40, 40, W - 80, H - 80);
    c.lineWidth = 3; c.strokeRect(70, 70, W - 140, H - 140);
    c.fillStyle = '#1f2937'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = 'bold 84px "Playfair Display", Georgia, serif'; c.fillText('CERTIFICATE', W / 2, 220);
    c.font = '34px "Montserrat", Arial, sans-serif'; c.letterSpacing = '10px'; c.fillText('OF ACHIEVEMENT', W / 2, 295); c.letterSpacing = '0px';
    c.font = 'italic 30px "Playfair Display", Georgia, serif'; c.fillStyle = '#6b7280'; c.fillText('This certificate is proudly presented to', W / 2, 420);
    c.strokeStyle = '#b08d57'; c.lineWidth = 2; c.beginPath(); c.moveTo(W * 0.2, 640); c.lineTo(W * 0.8, 640); c.stroke();
    c.font = '28px "Montserrat", Arial, sans-serif'; c.fillStyle = '#374151';
    c.fillText('for outstanding participation and performance in the Annual Tech Fest 2026', W / 2, 700);
    c.font = '22px "Montserrat", Arial, sans-serif'; c.fillStyle = '#6b7280';
    c.fillText('Director', W * 0.25, 960); c.fillText('Coordinator', W * 0.75, 960);
    c.beginPath(); c.moveTo(W * 0.15, 925); c.lineTo(W * 0.35, 925); c.moveTo(W * 0.65, 925); c.lineTo(W * 0.85, 925); c.stroke();
    return off;
  }

  if (new URLSearchParams(location.search).has('demo')) {
    ensureFonts().then(() => {
      const tpl = buildDemoTemplate();
      const img = new Image();
      img.onload = () => {
        state.template = img; state.templateName = 'demo_template.png';
        canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
        $('#stageEmpty').classList.add('hidden'); $('#canvasWrap').classList.remove('hidden');
        $('#templateDrop').classList.add('loaded');
        $('#templateMeta').classList.remove('hidden');
        $('#templateMeta').innerHTML = `<i class="fa-solid fa-check text-emerald-400 mr-1"></i>demo_template.png — ${img.naturalWidth}×${img.naturalHeight}px`;
        $('#canvasSize').textContent = `${img.naturalWidth} × ${img.naturalHeight} px`;
        fitZoom();
        $('#btnLoadSample').click();
        const W = canvas.width;
        const name = defaultField('name', W / 2, 540); name.size = 110; name.color = '#7c3aed'; name.maxWidth = Math.round(W * 0.65);
        const team = defaultField('team', W / 2, 760); team.size = 30; team.color = '#374151'; team.transform = 'uppercase'; team.spacing = 4;
        const cid = defaultField('certificate_id', W - 110, H_ANCHOR(1040)); cid.size = 20; cid.align = 'right'; cid.color = '#9ca3af';
        const qr = defaultField('qr_code', 150, 980); qr.qr.size = 130;
        state.fields.push(name, team, cid, qr);
        state.selectedId = name.id;
        renderLayers(); renderProps(); render();
        toast('Demo loaded: generated template + sample dataset.', 'info');
      };
      img.src = tpl.toDataURL('image/png');
    });
  }
  function H_ANCHOR(y) { return Math.min(y, canvas.height - 40); }
})();
