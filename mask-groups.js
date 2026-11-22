// =========================================================================
// BITMASK, MÚLTIPLOS GRUPOS NOMEADOS E TRANSFERÊNCIA (ORIGEM -> DESTINO)
// =========================================================================
(function () {
  class BitMask2D {
    constructor(w, h, words = null) {
      this.w = w;
      this.h = h;
      const totalBits = w * h;
      this.words = words ? new Uint32Array(words) : new Uint32Array(Math.ceil(totalBits / 32));
    }

    static fromByteMask(byteMask, w, h) {
      const bm = new BitMask2D(w, h);
      const len = Math.min(byteMask.length, w * h);
      for (let i = 0; i < len; i++) {
        if (byteMask[i]) bm.words[i >>> 5] |= (1 << (i & 31));
      }
      return bm;
    }

    toByteMask() {
      const out = new Uint8Array(this.w * this.h);
      for (let i = 0; i < out.length; i++) {
        out[i] = (this.words[i >>> 5] >>> (i & 31)) & 1;
      }
      return out;
    }

    get(x, y) {
      if (x < 0 || x >= this.w || y < 0 || y >= this.h) return 0;
      const idx = y * this.w + x;
      return (this.words[idx >>> 5] >>> (idx & 31)) & 1;
    }

    set(x, y, val = 1) {
      if (x < 0 || x >= this.w || y < 0 || y >= this.h) return;
      const idx = y * this.w + x;
      if (val) this.words[idx >>> 5] |= (1 << (idx & 31));
      else this.words[idx >>> 5] &= ~(1 << (idx & 31));
    }

    countBits() {
      let count = 0;
      for (let i = 0; i < this.words.length; i++) {
        let v = this.words[i];
        v = v - ((v >>> 1) & 0x55555555);
        v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
        count += (((v + (v >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
      }
      return count;
    }

    resampleTo(newW, newH) {
      if (this.w === newW && this.h === newH) return new BitMask2D(newW, newH, this.words);
      const out = new BitMask2D(newW, newH);
      for (let y = 0; y < newH; y++) {
        const sy = Math.floor((y / newH) * this.h);
        for (let x = 0; x < newW; x++) {
          const sx = Math.floor((x / newW) * this.w);
          if (this.get(sx, sy)) out.set(x, y, 1);
        }
      }
      return out;
    }

    toJSON() {
      return { w: this.w, h: this.h, words: Array.from(this.words) };
    }

    static fromJSON(obj) {
      return new BitMask2D(obj.w, obj.h, obj.words);
    }

    renderThumbnail(size = 28) {
      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#09090b';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#04d361';
      for (let py = 0; py < size; py++) {
        const gy = Math.floor((py / size) * this.h);
        for (let px = 0; px < size; px++) {
          const gx = Math.floor((px / size) * this.w);
          if (this.get(gx, gy)) ctx.fillRect(px, py, 1, 1);
        }
      }
      return c;
    }
  }

  window.BitMask2D = BitMask2D;

  window.createMaskGroupManager = function (deps) {
    const { state, transformEngine, render, updateSelectionBar, saveState } = deps;
    const MASKS_KEY = 'pixelbras_saved_masks_v1';
    const PREFS_KEY = 'pixelbras_paste_prefs_v1';

    let pastePrefs = { countMode: 'loop', maskMode: 'clip' };
    try {
      const savedPrefs = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
      if (savedPrefs && savedPrefs.countMode && savedPrefs.maskMode) pastePrefs = savedPrefs;
    } catch (_) {}

    function savePastePrefs() {
      localStorage.setItem(PREFS_KEY, JSON.stringify(pastePrefs));
    }

    // Biblioteca de Máscaras Bitmask
    let savedMasks = [];
    try {
      const raw = JSON.parse(localStorage.getItem(MASKS_KEY) || '[]');
      savedMasks = raw.map(item => ({
        id: item.id,
        name: item.name,
        bitmask: BitMask2D.fromJSON(item.bitmask)
      }));
    } catch (_) {
      savedMasks = [];
    }

    function persistMasks() {
      localStorage.setItem(MASKS_KEY, JSON.stringify(
        savedMasks.map(m => ({ id: m.id, name: m.name, bitmask: m.bitmask.toJSON() }))
      ));
    }

    // Múltiplos Grupos Nomeados: { id, name, active, targets: Map<"f:l", { frameIdx, layerIdx, maskId: number | null }> }
    let groups = [
      { id: 1, name: 'Grupo 1', active: false, targets: new Map() }
    ];
    let complexMode = localStorage.getItem('pixelbras_complex_mode') === '1';
    let editingGroupId = 1;
    let sourceGroupId = 1;
    let destGroupId = 1;
    let fallbackBitmask = null;

    function setComplexMode(enabled) {
      complexMode = Boolean(enabled);
      localStorage.setItem('pixelbras_complex_mode', complexMode ? '1' : '0');
      updateHeaderIndicator();
      renderGroupUI();
      render();
    }

    function getEditingGroup() {
      return groups.find(g => g.id === editingGroupId) || groups[0];
    }

    function getGroupById(id) {
      return groups.find(g => g.id === id) || null;
    }

    function keyOf(fIdx, lIdx) {
      return `${fIdx}:${lIdx}`;
    }

    function captureScreenMaskAsFallback() {
      const activeMaskBytes = transformEngine.getActiveFrameMask();
      if (activeMaskBytes && activeMaskBytes.some(v => v === 1)) {
        fallbackBitmask = BitMask2D.fromByteMask(activeMaskBytes, state.gridW, state.gridH);
      }
    }

    function resolveBitmask(maskId) {
      if (maskId) {
        const found = savedMasks.find(m => m.id === maskId);
        if (found) return found.bitmask.resampleTo(state.gridW, state.gridH);
      }
      return fallbackBitmask ? fallbackBitmask.resampleTo(state.gridW, state.gridH) : null;
    }

    // Verifica se algum grupo ATIVO restringe o desenho atual
    function isAnyGroupActive() {
      return complexMode && groups.some(g => g.active);
    }

    function canEditCurrentPixel(x, y) {
      if (!complexMode) return true;
      const activeGroups = groups.filter(g => g.active);
      if (activeGroups.length === 0) return true;
      const fr = state.frames[state.activeFrameIdx];
      if (!fr) return true;
      const k = keyOf(state.activeFrameIdx, fr.activeLayerIdx);

      for (const g of activeGroups) {
        const entry = g.targets.get(k);
        if (!entry) continue;
        const bm = resolveBitmask(entry.maskId);
        if (!bm || bm.get(x, y) === 1) return true;
      }
      return false;
    }

    function getCurrentActiveMaskBytes() {
      if (!complexMode) return null;
      const activeGroups = groups.filter(g => g.active);
      if (activeGroups.length === 0) return null;
      const fr = state.frames[state.activeFrameIdx];
      if (!fr) return null;
      const k = keyOf(state.activeFrameIdx, fr.activeLayerIdx);

      const combined = new Uint8Array(state.gridW * state.gridH);
      let hasAny = false;
      for (const g of activeGroups) {
        const entry = g.targets.get(k);
        if (!entry) continue;
        const bm = resolveBitmask(entry.maskId);
        if (bm) {
          const bytes = bm.toByteMask();
          for (let i = 0; i < bytes.length; i++) {
            if (bytes[i]) { combined[i] = 1; hasAny = true; }
          }
        }
      }
      return hasAny ? combined : null;
    }

    function updateHeaderIndicator() {
      const anyActive = isAnyGroupActive();
      const headerBtn = document.getElementById('btnHeaderMaskGroups');
      if (headerBtn) {
        headerBtn.classList.toggle('border-emerald-500', anyActive);
        headerBtn.classList.toggle('bg-emerald-950/60', anyActive);
        headerBtn.classList.toggle('text-emerald-400', anyActive);
        headerBtn.classList.toggle('border-purple-500', complexMode && !anyActive);
      }
      const modeBtn = document.getElementById('btnToggleComplexMode');
      if (modeBtn) {
        modeBtn.textContent = complexMode ? 'Modo Complexo: ON' : 'Modo Complexo: OFF';
        modeBtn.className = complexMode
          ? 'px-2.5 py-1 rounded-lg bg-emerald-500 text-zinc-950 font-bold text-xs'
          : 'px-2.5 py-1 rounded-lg bg-zinc-800 border border-zinc-600 text-zinc-300 font-semibold text-xs';
      }
      const bodyWrap = document.getElementById('complexModeBody');
      if (bodyWrap) {
        bodyWrap.classList.toggle('opacity-45', !complexMode);
        bodyWrap.classList.toggle('pointer-events-none', !complexMode);
      }
    }

    function createNewGroup(name) {
      const id = Date.now();
      groups.push({
        id,
        name: (name || '').trim() || `Grupo ${groups.length + 1}`,
        active: false,
        targets: new Map()
      });
      editingGroupId = id;
      destGroupId = id;
      renderGroupUI();
    }

    function deleteGroup(id) {
      if (groups.length <= 1) return alert('Mantenha pelo menos 1 grupo.');
      groups = groups.filter(g => g.id !== id);
      if (editingGroupId === id) editingGroupId = groups[0].id;
      if (sourceGroupId === id) sourceGroupId = groups[0].id;
      if (destGroupId === id) destGroupId = groups[0].id;
      updateHeaderIndicator();
      renderGroupUI();
      render();
    }

    function toggleGroupActive(id) {
      const g = getGroupById(id);
      if (!g) return;
      if (!g.active) captureScreenMaskAsFallback();
      g.active = !g.active;
      updateHeaderIndicator();
      renderGroupUI();
      render();
    }

    function getValidEntries(group) {
      const valid = [];
      for (const [k, entry] of group.targets.entries()) {
        const fr = state.frames[entry.frameIdx];
        if (fr && fr.layers[entry.layerIdx]) valid.push(entry);
        else group.targets.delete(k);
      }
      valid.sort((a, b) => (a.frameIdx - b.frameIdx) || (a.layerIdx - b.layerIdx));
      return valid;
    }

    function applyEditingGroupSelection(overrideMaskId = null) {
      const g = getEditingGroup();
      const entries = getValidEntries(g);
      if (entries.length === 0) return alert('Marque pelo menos 1 Quadro × Camada neste grupo.');
      captureScreenMaskAsFallback();
      saveState();

      const targetSpecs = entries.map(entry => {
        const bm = resolveBitmask(overrideMaskId || entry.maskId);
        return {
          frameIdx: entry.frameIdx,
          layerIdx: entry.layerIdx,
          maskBytes: bm ? bm.toByteMask() : null
        };
      }).filter(spec => spec.maskBytes && spec.maskBytes.some(v => v === 1));

      if (targetSpecs.length === 0) {
        alert('Nenhuma máscara definida. Faça uma seleção na tela ou escolha uma máscara salva na tabela.');
        return;
      }

      complexMode = true;
      localStorage.setItem('pixelbras_complex_mode', '1');
      g.active = true;
      updateHeaderIndicator();
      transformEngine.applyHeterogeneousTargets(targetSpecs);
      updateSelectionBar();
      render();
    }

    // Transferência direta: Grupo de Origem -> Grupo de Destino
    function transferGroupToGroup() {
      const srcGroup = getGroupById(sourceGroupId);
      const dstGroup = getGroupById(destGroupId);
      if (!srcGroup || !dstGroup) return;

      const srcEntries = getValidEntries(srcGroup);
      const dstEntries = getValidEntries(dstGroup);
      if (srcEntries.length === 0) return alert(`O grupo de origem "${srcGroup.name}" está vazio.`);
      if (dstEntries.length === 0) return alert(`O grupo de destino "${dstGroup.name}" está vazio.`);

      captureScreenMaskAsFallback();
      if (transformEngine.state.active) transformEngine.commit();
      saveState();

      // 1. Extrai snapshot da origem
      const srcSnapshots = srcEntries.map(entry => {
        const layer = state.frames[entry.frameIdx].layers[entry.layerIdx];
        const bm = resolveBitmask(entry.maskId);
        return { data: new Uint8Array(layer.data), mask: bm };
      });

      // 2. Cola no destino usando countMode + maskMode memorizados
      const countMode = pastePrefs.countMode;
      const maskMode = pastePrefs.maskMode;

      for (let i = 0; i < dstEntries.length; i++) {
        let sIdx = i;
        if (i >= srcSnapshots.length) {
          if (countMode === 'loop') sIdx = i % srcSnapshots.length;
          else if (countMode === 'hold') sIdx = srcSnapshots.length - 1;
          else break;
        }
        const src = srcSnapshots[sIdx];
        const dst = dstEntries[i];
        const dstLayer = state.frames[dst.frameIdx].layers[dst.layerIdx];
        const dstMask = resolveBitmask(dst.maskId);

        for (let y = 0; y < state.gridH; y++) {
          for (let x = 0; x < state.gridW; x++) {
            if (src.mask && !src.mask.get(x, y)) continue;
            if (maskMode === 'clip' && dstMask && !dstMask.get(x, y)) continue;
            const p = (y * state.gridW + x) * 4;
            if (src.data[p + 3] === 0) continue;
            dstLayer.data[p] = src.data[p];
            dstLayer.data[p + 1] = src.data[p + 1];
            dstLayer.data[p + 2] = src.data[p + 2];
            dstLayer.data[p + 3] = src.data[p + 3];
          }
        }
      }

      render();
      alert(`Transferência concluída: "${srcGroup.name}" → "${dstGroup.name}"!`);
    }

    function saveCurrentMaskToLibrary(name) {
      captureScreenMaskAsFallback();
      if (!fallbackBitmask || fallbackBitmask.countBits() === 0) {
        return alert('Faça primeiro uma seleção na tela (Retângulo, Laço ou Pincel) para salvar.');
      }
      savedMasks.push({
        id: Date.now(),
        name: (name || '').trim() || `Máscara #${savedMasks.length + 1}`,
        bitmask: fallbackBitmask.resampleTo(state.gridW, state.gridH)
      });
      persistMasks();
      renderGroupUI();
    }

    function renderGroupUI() {
      const groupsBar = document.getElementById('namedGroupsBar');
      const matrixContainer = document.getElementById('heteroMatrixList');
      const groupTableBody = document.getElementById('activeGroupTableBody');
      const libraryTableBody = document.getElementById('savedMasksTableBody');
      const srcSelect = document.getElementById('transferSourceGroupSelect');
      const dstSelect = document.getElementById('transferDestGroupSelect');
      if (!groupsBar || !matrixContainer) return;

      updateHeaderIndicator();
      const g = getEditingGroup();

      // 1. Barra de Grupos Nomeados
      groupsBar.innerHTML = '';
      groups.forEach(item => {
        const isEditing = item.id === g.id;
        const pill = document.createElement('div');
        pill.className = `flex items-center gap-1.5 px-2 py-1 rounded-lg border text-xs shrink-0 ${
          isEditing ? 'bg-purple-950/80 border-purple-400 text-white' : 'bg-zinc-800 border-zinc-700 text-zinc-300'
        }`;
        pill.innerHTML = `
          <button type="button" data-act="edit" class="font-semibold">${item.name} (${item.targets.size})</button>
          <button type="button" data-act="toggle" class="px-1.5 py-0.5 rounded text-[10px] font-bold ${item.active ? 'bg-emerald-500 text-zinc-950' : 'bg-zinc-700 text-zinc-300'}">${item.active ? 'ATIVO' : 'OFF'}</button>
          ${groups.length > 1 ? `<button type="button" data-act="del" class="text-red-400 font-bold px-0.5">&times;</button>` : ''}
        `;
        pill.querySelector('[data-act="edit"]').addEventListener('click', () => { editingGroupId = item.id; renderGroupUI(); });
        pill.querySelector('[data-act="toggle"]').addEventListener('click', () => toggleGroupActive(item.id));
        const delBtn = pill.querySelector('[data-act="del"]');
        if (delBtn) delBtn.addEventListener('click', () => deleteGroup(item.id));
        groupsBar.appendChild(pill);
      });

      // Atualiza seletores Origem -> Destino
      if (srcSelect && dstSelect) {
        const opts = groups.map(item => `<option value="${item.id}">${item.name} (${item.targets.size} alvos)</option>`).join('');
        srcSelect.innerHTML = opts;
        dstSelect.innerHTML = opts;
        srcSelect.value = String(sourceGroupId);
        dstSelect.value = String(destGroupId);
      }

      const selCount = document.getElementById('pasteCountModeSelect');
      const selMask = document.getElementById('pasteMaskModeSelect');
      if (selCount) selCount.value = pastePrefs.countMode;
      if (selMask) selMask.value = pastePrefs.maskMode;

      // 2. Matriz Quadro × Camada (Permite desmarcar QUALQUER um, inclusive o quadro ativo!)
      matrixContainer.innerHTML = '';
      state.frames.forEach((fr, fIdx) => {
        const card = document.createElement('div');
        card.className = 'flex flex-col gap-1 p-1.5 rounded-lg bg-zinc-950/90 border border-zinc-800 shrink-0 min-w-[110px]';
        card.innerHTML = `<span class="text-[10px] font-bold text-orange-400">Quadro #${fIdx + 1}</span>`;

        fr.layers.forEach((layer, lIdx) => {
          const k = keyOf(fIdx, lIdx);
          const isChecked = g.targets.has(k);
          const lbl = document.createElement('label');
          lbl.className = `flex items-center gap-1.5 px-1.5 py-1 rounded text-[11px] cursor-pointer ${isChecked ? 'bg-purple-950/70 text-purple-200 border border-purple-600/60' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`;
          lbl.innerHTML = `<input type="checkbox" ${isChecked ? 'checked' : ''} class="accent-purple-500"> <span class="truncate">${layer.name}</span>`;
          lbl.querySelector('input').addEventListener('change', () => {
            if (g.targets.has(k)) g.targets.delete(k);
            else g.targets.set(k, { frameIdx: fIdx, layerIdx: lIdx, maskId: null });
            renderGroupUI();
            if (g.active) render();
          });
          card.appendChild(lbl);
        });
        matrixContainer.appendChild(card);
      });

      // 3. Tabela de Máscara Individual por Quadro × Camada do grupo em edição
      groupTableBody.innerHTML = '';
      const entries = getValidEntries(g);
      if (entries.length === 0) {
        groupTableBody.innerHTML = `<tr><td colspan="4" class="py-3 text-center text-zinc-500">Marque acima os Quadros e Camadas que pertencem a "${g.name}".</td></tr>`;
      } else {
        for (const entry of entries) {
          const layer = state.frames[entry.frameIdx].layers[entry.layerIdx];
          const tr = document.createElement('tr');
          tr.className = 'border-b border-zinc-800/80';

          const selectOptions = [
            `<option value="">(Máscara Atual da Tela)</option>`,
            ...savedMasks.map(m => `<option value="${m.id}" ${entry.maskId === m.id ? 'selected' : ''}>${m.name} (${m.bitmask.countBits()}px)</option>`)
          ].join('');

          tr.innerHTML = `
            <td class="py-1.5 px-2 font-mono text-orange-300">#${entry.frameIdx + 1}</td>
            <td class="py-1.5 px-2 text-purple-300 truncate max-w-[90px]">${layer.name}</td>
            <td class="py-1.5 px-2">
              <select class="w-full bg-zinc-800 border border-zinc-700 rounded px-1.5 py-1 text-[11px] text-zinc-200">
                ${selectOptions}
              </select>
            </td>
            <td class="py-1.5 px-1 text-right">
              <button type="button" class="text-red-400 hover:text-red-300 px-1.5 font-bold">&times;</button>
            </td>
          `;

          tr.querySelector('select').addEventListener('change', e => {
            entry.maskId = e.target.value ? parseInt(e.target.value, 10) : null;
            if (g.active) render();
          });
          tr.querySelector('button').addEventListener('click', () => {
            g.targets.delete(keyOf(entry.frameIdx, entry.layerIdx));
            renderGroupUI();
            if (g.active) render();
          });
          groupTableBody.appendChild(tr);
        }
      }

      // 4. Biblioteca de Máscaras Salvas
      libraryTableBody.innerHTML = '';
      if (savedMasks.length === 0) {
        libraryTableBody.innerHTML = `<tr><td colspan="3" class="py-3 text-center text-zinc-500">Nenhuma máscara salva ainda. Selecione uma área na tela e clique em "+ Salvar Atual".</td></tr>`;
        return;
      }

      savedMasks.forEach((m, idx) => {
        const tr = document.createElement('tr');
        tr.className = 'border-b border-zinc-800/80 hover:bg-zinc-800/40';
        const thumb = m.bitmask.renderThumbnail(28);
        thumb.className = 'w-7 h-7 rounded border border-zinc-700';

        const tdThumb = document.createElement('td');
        tdThumb.className = 'py-1.5 px-2';
        tdThumb.appendChild(thumb);

        const tdInfo = document.createElement('td');
        tdInfo.className = 'py-1.5 px-2';
        tdInfo.innerHTML = `<div class="font-semibold text-zinc-200">${m.name}</div><div class="text-[10px] font-mono text-zinc-400">${m.bitmask.w}×${m.bitmask.h} • ${m.bitmask.countBits()} bits</div>`;

        const tdActions = document.createElement('td');
        tdActions.className = 'py-1.5 px-2 text-right whitespace-nowrap';
        tdActions.innerHTML = `
          <button type="button" data-act="apply" class="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-zinc-950 font-bold text-[11px] mr-1">Usar no Grupo</button>
          <button type="button" data-act="del" class="px-1.5 py-1 rounded bg-zinc-800 text-red-400 font-bold text-[11px]">&times;</button>
        `;

        tdActions.querySelector('[data-act="apply"]').addEventListener('click', () => applyEditingGroupSelection(m.id));
        tdActions.querySelector('[data-act="del"]').addEventListener('click', () => {
          savedMasks.splice(idx, 1);
          persistMasks();
          renderGroupUI();
        });

        tr.appendChild(tdThumb);
        tr.appendChild(tdInfo);
        tr.appendChild(tdActions);
        libraryTableBody.appendChild(tr);
      });
    }

    return {
      isComplexMode: () => complexMode,
      setComplexMode,
      toggleComplexMode: () => setComplexMode(!complexMode),
      isGroupActive: isAnyGroupActive,
      canEditCurrentPixel,
      getCurrentActiveMaskBytes,
      captureScreenMaskAsFallback,
      renderGroupUI,
      createNewGroup,
      saveCurrentMaskToLibrary,
      applyGroupSelection: () => applyEditingGroupSelection(null),
      transferGroupToGroup,
      setSourceGroupId: id => { sourceGroupId = parseInt(id, 10); },
      setDestGroupId: id => { destGroupId = parseInt(id, 10); },
      setPasteCountMode: mode => { pastePrefs.countMode = mode; savePastePrefs(); },
      setPasteMaskMode: mode => { pastePrefs.maskMode = mode; savePastePrefs(); },
      clearEditingGroup: () => { getEditingGroup().targets.clear(); renderGroupUI(); render(); }
    };
  };
})();
