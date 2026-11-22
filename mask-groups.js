// =========================================================================
// CAMPO DE BITS (BITMASK), GRUPOS HETEROGÊNEOS E BIBLIOTECA DE MÁSCARAS
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

    // Operação booleana bitwise ultrarrápida ('replace' | 'add' | 'sub')
    combine(other, op = 'replace') {
      const out = new BitMask2D(this.w, this.h);
      const len = Math.min(this.words.length, other.words.length);
      for (let i = 0; i < len; i++) {
        if (op === 'add') out.words[i] = this.words[i] | other.words[i];
        else if (op === 'sub') out.words[i] = this.words[i] & ~other.words[i];
        else out.words[i] = other.words[i];
      }
      return out;
    }

    // Reamostra bitmask caso o tamanho do canvas tenha mudado
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

    renderThumbnail(size = 32) {
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
    const STORAGE_KEY = 'pixelbras_saved_masks_v1';

    // Biblioteca persistente de máscaras bitmask
    let savedMasks = [];
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      savedMasks = raw.map(item => ({
        id: item.id,
        name: item.name,
        bitmask: BitMask2D.fromJSON(item.bitmask)
      }));
    } catch (_) {
      savedMasks = [];
    }

    function persistLibrary() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(
        savedMasks.map(m => ({ id: m.id, name: m.name, bitmask: m.bitmask.toJSON() }))
      ));
    }

    // Grupo heterogêneo: Map de "frameIdx:layerIdx" -> { frameIdx, layerIdx, bitmask: BitMask2D | null }
    const targetGroup = new Map();

    function keyOf(fIdx, lIdx) {
      return `${fIdx}:${lIdx}`;
    }

    function ensureCurrentTargetInGroup() {
      const fr = state.frames[state.activeFrameIdx];
      if (!fr) return;
      const k = keyOf(state.activeFrameIdx, fr.activeLayerIdx);
      if (!targetGroup.has(k)) {
        targetGroup.set(k, { frameIdx: state.activeFrameIdx, layerIdx: fr.activeLayerIdx, bitmask: null });
      }
    }

    function toggleTarget(fIdx, lIdx, customBitmask = null) {
      const k = keyOf(fIdx, lIdx);
      if (targetGroup.has(k)) {
        targetGroup.delete(k);
      } else {
        targetGroup.set(k, { frameIdx: fIdx, layerIdx: lIdx, bitmask: customBitmask });
      }
      renderGroupUI();
    }

    function assignMaskToTarget(fIdx, lIdx, bitmask) {
      const k = keyOf(fIdx, lIdx);
      targetGroup.set(k, {
        frameIdx: fIdx,
        layerIdx: lIdx,
        bitmask: bitmask ? bitmask.resampleTo(state.gridW, state.gridH) : null
      });
      renderGroupUI();
    }

    function getTargetEntries() {
      ensureCurrentTargetInGroup();
      const valid = [];
      for (const [k, entry] of targetGroup.entries()) {
        const fr = state.frames[entry.frameIdx];
        if (fr && fr.layers[entry.layerIdx]) {
          valid.push(entry);
        } else {
          targetGroup.delete(k);
        }
      }
      return valid;
    }

    // Salva a máscara atual (do quadro/camada ativo) como BitMask2D na biblioteca
    function saveCurrentMaskToLibrary(name) {
      const activeMaskBytes = transformEngine.getActiveFrameMask();
      if (!activeMaskBytes) {
        alert('Faça primeiro uma seleção na tela para salvar como máscara.');
        return;
      }
      const bm = BitMask2D.fromByteMask(activeMaskBytes, state.gridW, state.gridH);
      if (bm.countBits() === 0) return;

      savedMasks.push({
        id: Date.now(),
        name: (name || '').trim() || `Máscara #${savedMasks.length + 1}`,
        bitmask: bm
      });
      persistLibrary();
      renderGroupUI();
    }

    // Aplica o grupo inteiro (cada item pode usar sua máscara individual vinculada ou uma máscara global)
    function applyGroupSelection(overrideGlobalBitmask = null) {
      const entries = getTargetEntries();
      if (entries.length === 0) return;

      saveState();
      const globalBytes = overrideGlobalBitmask
        ? overrideGlobalBitmask.resampleTo(state.gridW, state.gridH).toByteMask()
        : transformEngine.getActiveFrameMask();

      const targetSpecs = entries.map(entry => {
        const specificBytes = entry.bitmask
          ? entry.bitmask.resampleTo(state.gridW, state.gridH).toByteMask()
          : globalBytes;
        return {
          frameIdx: entry.frameIdx,
          layerIdx: entry.layerIdx,
          maskBytes: specificBytes
        };
      }).filter(spec => spec.maskBytes && spec.maskBytes.some(v => v === 1));

      if (targetSpecs.length === 0) {
        alert('Nenhuma máscara ativa ou vinculada ao grupo. Selecione uma área na tela ou escolha uma máscara salva.');
        return;
      }

      transformEngine.applyHeterogeneousTargets(targetSpecs);
      updateSelectionBar();
      render();
    }

    // Renderiza a tabela de alvos heterogêneos (Quadro × Camada) e a tabela de Máscaras Bitmask salvas
    function renderGroupUI() {
      const matrixContainer = document.getElementById('heteroMatrixList');
      const groupTableBody = document.getElementById('activeGroupTableBody');
      const libraryTableBody = document.getElementById('savedMasksTableBody');
      if (!matrixContainer || !groupTableBody || !libraryTableBody) return;

      ensureCurrentTargetInGroup();

      // 1. Matriz rápida de seleção de qualquer Quadro × Camada
      matrixContainer.innerHTML = '';
      state.frames.forEach((fr, fIdx) => {
        const card = document.createElement('div');
        card.className = 'flex flex-col gap-1 p-1.5 rounded-lg bg-zinc-950/90 border border-zinc-800 shrink-0 min-w-[110px]';
        card.innerHTML = `<span class="text-[10px] font-bold text-orange-400">Quadro #${fIdx + 1}</span>`;

        fr.layers.forEach((layer, lIdx) => {
          const k = keyOf(fIdx, lIdx);
          const isChecked = targetGroup.has(k);
          const lbl = document.createElement('label');
          lbl.className = `flex items-center gap-1.5 px-1.5 py-1 rounded text-[11px] cursor-pointer ${isChecked ? 'bg-purple-950/70 text-purple-200 border border-purple-600/60' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`;
          lbl.innerHTML = `<input type="checkbox" ${isChecked ? 'checked' : ''} class="accent-purple-500"> <span class="truncate">${layer.name}</span>`;
          lbl.querySelector('input').addEventListener('change', () => toggleTarget(fIdx, lIdx));
          card.appendChild(lbl);
        });
        matrixContainer.appendChild(card);
      });

      // 2. Tabela do Grupo Ativo (mostra qual máscara cada Quadro/Camada vai usar)
      groupTableBody.innerHTML = '';
      for (const entry of getTargetEntries()) {
        const fr = state.frames[entry.frameIdx];
        const layer = fr.layers[entry.layerIdx];
        const tr = document.createElement('tr');
        tr.className = 'border-b border-zinc-800/80';

        const selectOptions = [
          `<option value="">(Máscara Atual da Tela)</option>`,
          ...savedMasks.map(m => `<option value="${m.id}" ${entry.bitmask && entry.bitmask === m.bitmask ? 'selected' : ''}>${m.name} (${m.bitmask.countBits()}px)</option>`)
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
          const id = parseInt(e.target.value, 10);
          const found = savedMasks.find(m => m.id === id);
          assignMaskToTarget(entry.frameIdx, entry.layerIdx, found ? found.bitmask : null);
        });

        tr.querySelector('button').addEventListener('click', () => {
          targetGroup.delete(keyOf(entry.frameIdx, entry.layerIdx));
          renderGroupUI();
        });

        groupTableBody.appendChild(tr);
      }

      // 3. Tabela da Biblioteca de Máscaras (Bitmask)
      libraryTableBody.innerHTML = '';
      if (savedMasks.length === 0) {
        libraryTableBody.innerHTML = `<tr><td colspan="4" class="py-3 text-center text-zinc-500">Nenhuma máscara salva ainda. Selecione uma área e clique em "+ Salvar Atual".</td></tr>`;
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
          <button type="button" data-act="apply" class="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-zinc-950 font-bold text-[11px] mr-1">Aplicar</button>
          <button type="button" data-act="del" class="px-1.5 py-1 rounded bg-zinc-800 text-red-400 font-bold text-[11px]">&times;</button>
        `;

        tdActions.querySelector('[data-act="apply"]').addEventListener('click', () => {
          applyGroupSelection(m.bitmask);
        });
        tdActions.querySelector('[data-act="del"]').addEventListener('click', () => {
          savedMasks.splice(idx, 1);
          persistLibrary();
          renderGroupUI();
        });

        tr.appendChild(tdThumb);
        tr.appendChild(tdInfo);
        tr.appendChild(tdActions);
        libraryTableBody.appendChild(tr);
      });
    }

    function exportJSON() {
      const payload = {
        version: 1,
        masks: savedMasks.map(m => ({ id: m.id, name: m.name, bitmask: m.bitmask.toJSON() })),
        group: getTargetEntries().map(e => ({
          frameIdx: e.frameIdx,
          layerIdx: e.layerIdx,
          bitmask: e.bitmask ? e.bitmask.toJSON() : null
        }))
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.download = 'pixelbras-mascaras-grupos.json';
      a.href = url;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function importJSON(file) {
      const reader = new FileReader();
      reader.onload = ev => {
        try {
          const data = JSON.parse(ev.target.result);
          if (Array.isArray(data.masks)) {
            data.masks.forEach(m => {
              savedMasks.push({
                id: Date.now() + Math.random(),
                name: m.name || 'Máscara Importada',
                bitmask: BitMask2D.fromJSON(m.bitmask)
              });
            });
            persistLibrary();
          }
          if (Array.isArray(data.group)) {
            targetGroup.clear();
            data.group.forEach(g => {
              if (state.frames[g.frameIdx] && state.frames[g.frameIdx].layers[g.layerIdx]) {
                targetGroup.set(keyOf(g.frameIdx, g.layerIdx), {
                  frameIdx: g.frameIdx,
                  layerIdx: g.layerIdx,
                  bitmask: g.bitmask ? BitMask2D.fromJSON(g.bitmask) : null
                });
              }
            });
          }
          renderGroupUI();
        } catch (err) {
          alert('Arquivo JSON de máscaras inválido.');
        }
      };
      reader.readAsText(file);
    }

    return {
      renderGroupUI,
      saveCurrentMaskToLibrary,
      applyGroupSelection,
      clearGroup: () => { targetGroup.clear(); ensureCurrentTargetInGroup(); renderGroupUI(); },
      exportJSON,
      importJSON
    };
  };
})();
