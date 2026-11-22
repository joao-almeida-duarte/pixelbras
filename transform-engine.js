// =========================================================================
// MOTOR ABSTRATO DE SELEÇÃO MULTI-QUADRO / MULTI-CAMADA E TRANSFORMAÇÃO 2D
// =========================================================================
(function () {
  window.createSelectionTransformEngine = function (deps) {
    const {
      state, canvas, workspace,
      getActiveFrame, getActiveLayer, getActivePixels,
      getSelectedFrames, getSelectedLayers,
      saveState, render, updateStatus, setPixelRaw, getPixel
    } = deps;

    // Estado interno do grupo de seleção e transformação
    const selState = {
      active: false,
      mode: 'replace',       // 'replace' | 'add' | 'sub'
      transformMode: false,  // false = mover simples | true = exibir alças (ampliar/girar/shear)
      baseX: 0,
      baseY: 0,
      baseW: 0,
      baseH: 0,
      // Parâmetros de transformação
      tx: 0,
      ty: 0,
      scaleX: 1,
      scaleY: 1,
      angle: 0,    // radianos
      skewX: 0,    // tangente/fator horizontal
      skewY: 0,    // tangente/fator vertical
      // Lista de recortes extraídos por [frameIdx, layerIdx]:
      // { frameIdx, layerIdx, data: Uint8Array(baseW*baseH*4), mask: Uint8Array(baseW*baseH) }
      clips: []
    };

    // Canvas overlay transparente sobre o canvas WebGL para desenhar as alças de transformação com nitidez
    const overlay = document.createElement('canvas');
    overlay.id = 'transformOverlay';
    overlay.style.position = 'absolute';
    overlay.style.pointerEvents = 'none';
    overlay.style.zIndex = '15';
    workspace.appendChild(overlay);
    const octx = overlay.getContext('2d');

    function syncOverlayBounds() {
      const wRect = workspace.getBoundingClientRect();
      const cRect = canvas.getBoundingClientRect();
      overlay.style.left = (cRect.left - wRect.left) + 'px';
      overlay.style.top = (cRect.top - wRect.top) + 'px';
      overlay.width = Math.max(1, Math.round(cRect.width));
      overlay.height = Math.max(1, Math.round(cRect.height));
      overlay.style.width = cRect.width + 'px';
      overlay.style.height = cRect.height + 'px';
    }

    // Mapeia ponto do espaço local da seleção (relativo ao centro) para coordenadas do grid
    function localToGrid(lx, ly) {
      const cx = selState.baseX + selState.baseW / 2 + selState.tx;
      const cy = selState.baseY + selState.baseH / 2 + selState.ty;

      // 1. Escala (suporta negativa -> espelhamento)
      let x = lx * selState.scaleX;
      let y = ly * selState.scaleY;

      // 2. Shear (cisalhamento)
      const sx = x + y * selState.skewX;
      const sy = y + x * selState.skewY;

      // 3. Rotação
      const cos = Math.cos(selState.angle);
      const sin = Math.sin(selState.angle);
      const rx = sx * cos - sy * sin;
      const ry = sx * sin + sy * cos;

      return [cx + rx, cy + ry];
    }

    // Mapeia coordenada do grid para o espaço local original (inversa exata para Nearest-Neighbor)
    function gridToLocal(gx, gy) {
      const cx = selState.baseX + selState.baseW / 2 + selState.tx;
      const cy = selState.baseY + selState.baseH / 2 + selState.ty;
      const dx = gx - cx;
      const dy = gy - cy;

      // Inversa da Rotação
      const cos = Math.cos(-selState.angle);
      const sin = Math.sin(-selState.angle);
      const rx = dx * cos - dy * sin;
      const ry = dx * sin + dy * cos;

      // Inversa do Shear: [1, skewX; skewY, 1]
      const det = 1 - selState.skewX * selState.skewY;
      const safeDet = Math.abs(det) < 1e-4 ? (det < 0 ? -1e-4 : 1e-4) : det;
      const ux = (rx - ry * selState.skewX) / safeDet;
      const uy = (ry - rx * selState.skewY) / safeDet;

      // Inversa da Escala
      const sX = Math.abs(selState.scaleX) < 1e-3 ? (selState.scaleX < 0 ? -1e-3 : 1e-3) : selState.scaleX;
      const sY = Math.abs(selState.scaleY) < 1e-3 ? (selState.scaleY < 0 ? -1e-3 : 1e-3) : selState.scaleY;

      return [ux / sX, uy / sY];
    }

    // Amostra um clip transformado na grade (gridW x gridH)
    function sampleClipToGrid(clip) {
      const outData = new Uint8Array(state.gridW * state.gridH * 4);
      const outMask = new Uint8Array(state.gridW * state.gridH);
      const halfW = selState.baseW / 2;
      const halfH = selState.baseH / 2;

      for (let gy = 0; gy < state.gridH; gy++) {
        for (let gx = 0; gx < state.gridW; gx++) {
          const [lx, ly] = gridToLocal(gx + 0.5, gy + 0.5);
          const sx = Math.floor(lx + halfW);
          const sy = Math.floor(ly + halfH);
          if (sx >= 0 && sx < selState.baseW && sy >= 0 && sy < selState.baseH) {
            const mIdx = sy * selState.baseW + sx;
            if (clip.mask[mIdx]) {
              const gIdx = gy * state.gridW + gx;
              outMask[gIdx] = 1;
              const sIdx = mIdx * 4;
              const dIdx = gIdx * 4;
              outData[dIdx] = clip.data[sIdx];
              outData[dIdx + 1] = clip.data[sIdx + 1];
              outData[dIdx + 2] = clip.data[sIdx + 2];
              outData[dIdx + 3] = clip.data[sIdx + 3];
            }
          }
        }
      }
      return { data: outData, mask: outMask };
    }

    // Obtém a lista alvo de pares { frameIdx, layerIdx } marcada pelo usuário
    function getTargetTargets() {
      const framesIdx = getSelectedFrames();
      const layersIdx = getSelectedLayers();
      const targets = [];

      for (const fIdx of framesIdx) {
        const fr = state.frames[fIdx];
        if (!fr) continue;
        // Se apenas 1 quadro está selecionado, usa todas as camadas marcadas nele;
        // se múltiplos quadros estão selecionados, aplica nas mesmas camadas equivalentes (ou na camada ativa de cada quadro)
        if (framesIdx.length === 1) {
          for (const lIdx of layersIdx) {
            if (fr.layers[lIdx]) targets.push({ frameIdx: fIdx, layerIdx: lIdx });
          }
        } else {
          let matchedAny = false;
          for (const lIdx of layersIdx) {
            if (fr.layers[lIdx]) {
              targets.push({ frameIdx: fIdx, layerIdx: lIdx });
              matchedAny = true;
            }
          }
          if (!matchedAny && fr.layers[fr.activeLayerIdx]) {
            targets.push({ frameIdx: fIdx, layerIdx: fr.activeLayerIdx });
          }
        }
      }
      return targets;
    }

    // Fixa (grava) todos os clips transformados de volta nos respectivos quadros e camadas
    function commit() {
      if (!selState.active) return;
      for (const clip of selState.clips) {
        const fr = state.frames[clip.frameIdx];
        if (!fr || !fr.layers[clip.layerIdx]) continue;
        const targetBuf = fr.layers[clip.layerIdx].data;
        const sampled = sampleClipToGrid(clip);
        for (let i = 0; i < sampled.mask.length; i++) {
          if (sampled.mask[i] && sampled.data[i * 4 + 3] > 0) {
            const p = i * 4;
            targetBuf[p] = sampled.data[p];
            targetBuf[p + 1] = sampled.data[p + 1];
            targetBuf[p + 2] = sampled.data[p + 2];
            targetBuf[p + 3] = sampled.data[p + 3];
          }
        }
      }
      clear();
      render();
    }

    function clear() {
      selState.active = false;
      selState.clips = [];
      selState.tx = 0; selState.ty = 0;
      selState.scaleX = 1; selState.scaleY = 1;
      selState.angle = 0;
      selState.skewX = 0; selState.skewY = 0;
      state.selection = null;
      drawOverlay();
    }

    // Aplica uma nova máscara booleana (replace, add, sub) em todos os Quadros/Camadas selecionados
    function applyMask(newMask) {
      // Reconstrói máscara global atual antes da modificação
      const prevFullMask = new Uint8Array(state.gridW * state.gridH);
      if (selState.active && selState.clips.length > 0) {
        const refSample = sampleClipToGrid(selState.clips[0]);
        prevFullMask.set(refSample.mask);

        // Restaura temporariamente os pixels já extraídos para recalcular a união/subtração sem perda
        for (const clip of selState.clips) {
          const fr = state.frames[clip.frameIdx];
          if (!fr || !fr.layers[clip.layerIdx]) continue;
          const targetBuf = fr.layers[clip.layerIdx].data;
          const sampled = sampleClipToGrid(clip);
          for (let i = 0; i < sampled.mask.length; i++) {
            if (sampled.mask[i] && sampled.data[i * 4 + 3] > 0) {
              const p = i * 4;
              targetBuf[p] = sampled.data[p];
              targetBuf[p + 1] = sampled.data[p + 1];
              targetBuf[p + 2] = sampled.data[p + 2];
              targetBuf[p + 3] = sampled.data[p + 3];
            }
          }
        }
      }

      const combinedMask = new Uint8Array(state.gridW * state.gridH);
      let minX = state.gridW, minY = state.gridH, maxX = -1, maxY = -1;

      for (let y = 0; y < state.gridH; y++) {
        for (let x = 0; x < state.gridW; x++) {
          const idx = y * state.gridW + x;
          let selected = false;
          if (selState.mode === 'add') selected = Boolean(prevFullMask[idx] || newMask[idx]);
          else if (selState.mode === 'sub') selected = Boolean(prevFullMask[idx] && !newMask[idx]);
          else selected = Boolean(newMask[idx]);

          if (selected) {
            combinedMask[idx] = 1;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      if (maxX < minX || maxY < minY) {
        clear();
        render();
        return;
      }

      const w = maxX - minX + 1;
      const h = maxY - minY + 1;
      const targets = getTargetTargets();
      const newClips = [];

      for (const t of targets) {
        const buf = state.frames[t.frameIdx].layers[t.layerIdx].data;
        const clipData = new Uint8Array(w * h * 4);
        const clipMask = new Uint8Array(w * h);

        for (let sy = 0; sy < h; sy++) {
          for (let sx = 0; sx < w; sx++) {
            const gx = minX + sx, gy = minY + sy;
            const gIdx = gy * state.gridW + gx;
            if (combinedMask[gIdx]) {
              const mIdx = sy * w + sx;
              clipMask[mIdx] = 1;
              const p = getPixel(buf, state.gridW, gx, gy);
              const dIdx = mIdx * 4;
              clipData[dIdx] = p[0]; clipData[dIdx + 1] = p[1];
              clipData[dIdx + 2] = p[2]; clipData[dIdx + 3] = p[3];
              setPixelRaw(buf, state.gridW, state.gridH, gx, gy, [0, 0, 0, 0]);
            }
          }
        }
        newClips.push({ frameIdx: t.frameIdx, layerIdx: t.layerIdx, data: clipData, mask: clipMask });
      }

      selState.active = true;
      selState.baseX = minX;
      selState.baseY = minY;
      selState.baseW = w;
      selState.baseH = h;
      selState.tx = 0; selState.ty = 0;
      selState.scaleX = 1; selState.scaleY = 1;
      selState.angle = 0;
      selState.skewX = 0; selState.skewY = 0;
      selState.clips = newClips;
      state.selection = selState; // Mantém compatibilidade de checagem booleana

      render();
    }

    // Usado pelo pipeline de composição WebGL para renderizar o preview do quadro/camada atual
    // Aplica uma lista heterogênea: [{ frameIdx, layerIdx, maskBytes }, ...]
    function applyHeterogeneousTargets(targetSpecs) {
      commit();
      let minX = state.gridW, minY = state.gridH, maxX = -1, maxY = -1;

      for (const spec of targetSpecs) {
        for (let y = 0; y < state.gridH; y++) {
          for (let x = 0; x < state.gridW; x++) {
            if (spec.maskBytes[y * state.gridW + x]) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
      }

      if (maxX < minX || maxY < minY) return;

      const w = maxX - minX + 1;
      const h = maxY - minY + 1;
      const newClips = [];

      for (const spec of targetSpecs) {
        const fr = state.frames[spec.frameIdx];
        if (!fr || !fr.layers[spec.layerIdx]) continue;
        const buf = fr.layers[spec.layerIdx].data;
        const clipData = new Uint8Array(w * h * 4);
        const clipMask = new Uint8Array(w * h);

        for (let sy = 0; sy < h; sy++) {
          for (let sx = 0; sx < w; sx++) {
            const gx = minX + sx, gy = minY + sy;
            const gIdx = gy * state.gridW + gx;
            if (spec.maskBytes[gIdx]) {
              const mIdx = sy * w + sx;
              clipMask[mIdx] = 1;
              const p = getPixel(buf, state.gridW, gx, gy);
              const dIdx = mIdx * 4;
              clipData[dIdx] = p[0]; clipData[dIdx + 1] = p[1];
              clipData[dIdx + 2] = p[2]; clipData[dIdx + 3] = p[3];
              setPixelRaw(buf, state.gridW, state.gridH, gx, gy, [0, 0, 0, 0]);
            }
          }
        }
        newClips.push({ frameIdx: spec.frameIdx, layerIdx: spec.layerIdx, data: clipData, mask: clipMask });
      }

      selState.active = true;
      selState.baseX = minX;
      selState.baseY = minY;
      selState.baseW = w;
      selState.baseH = h;
      selState.tx = 0; selState.ty = 0;
      selState.scaleX = 1; selState.scaleY = 1;
      selState.angle = 0;
      selState.skewX = 0; selState.skewY = 0;
      selState.clips = newClips;
      state.selection = selState;
    }

    function getTransformedClipFor(frameIdx, layerIdx) {
      if (!selState.active) return null;
      const clip = selState.clips.find(c => c.frameIdx === frameIdx && c.layerIdx === layerIdx);
      if (!clip) return null;
      return sampleClipToGrid(clip);
    }

    function getActiveFrameMask() {
      if (!selState.active || selState.clips.length === 0) return null;
      const clip = selState.clips.find(c => c.frameIdx === state.activeFrameIdx) || selState.clips[0];
      return sampleClipToGrid(clip).mask;
    }

    // =====================================================================
    // ALÇAS INTERATIVAS DE TRANSFORMAÇÃO (ESCALA/ESPELHAR, ROTAÇÃO, SHEAR)
    // =====================================================================
    function getHandlesScreenPositions() {
      if (!selState.active || !selState.transformMode) return [];
      syncOverlayBounds();
      const scaleXpx = overlay.width / state.gridW;
      const scaleYpx = overlay.height / state.gridH;
      const hw = selState.baseW / 2;
      const hh = selState.baseH / 2;

      const toScreen = (lx, ly) => {
        const [gx, gy] = localToGrid(lx, ly);
        return { x: gx * scaleXpx, y: gy * scaleYpx };
      };

      const handles = [
        // 4 Cantos (Proporcional + Espelhar)
        { id: 'nw', lx: -hw, ly: -hh, color: '#04d361', shape: 'rect' },
        { id: 'ne', lx:  hw, ly: -hh, color: '#04d361', shape: 'rect' },
        { id: 'se', lx:  hw, ly:  hh, color: '#04d361', shape: 'rect' },
        { id: 'sw', lx: -hw, ly:  hh, color: '#04d361', shape: 'rect' },
        // 4 Meios-lados (Horizontal / Vertical + Espelhar)
        { id: 'n',  lx:   0, ly: -hh, color: '#38bdf8', shape: 'rect' },
        { id: 's',  lx:   0, ly:  hh, color: '#38bdf8', shape: 'rect' },
        { id: 'w',  lx: -hw, ly:   0, color: '#38bdf8', shape: 'rect' },
        { id: 'e',  lx:  hw, ly:   0, color: '#38bdf8', shape: 'rect' },
        // Alça de Shear (Inclinação horizontal no topo interno e vertical na lateral)
        { id: 'shearX', lx: 0, ly: -hh * 0.55, color: '#f59e0b', shape: 'diamond' },
        { id: 'shearY', lx: hw * 0.55, ly: 0,  color: '#f59e0b', shape: 'diamond' }
      ];

      const mapped = handles.map(h => ({ ...h, ...toScreen(h.lx, h.ly) }));

      // Alça de Rotação projetada acima da borda superior
      const topCenter = toScreen(0, -hh);
      const center = toScreen(0, 0);
      let vx = topCenter.x - center.x;
      let vy = topCenter.y - center.y;
      const vLen = Math.hypot(vx, vy) || 1;
      vx /= vLen; vy /= vLen;
      mapped.push({
        id: 'rotate',
        x: topCenter.x + vx * 24,
        y: topCenter.y + vy * 24,
        anchorX: topCenter.x,
        anchorY: topCenter.y,
        color: '#f43f5e',
        shape: 'circle'
      });

      return mapped;
    }

    function drawOverlay() {
      syncOverlayBounds();
      octx.clearRect(0, 0, overlay.width, overlay.height);
      if (!selState.active || !selState.transformMode) return;

      const handles = getHandlesScreenPositions();
      const nw = handles.find(h => h.id === 'nw');
      const ne = handles.find(h => h.id === 'ne');
      const se = handles.find(h => h.id === 'se');
      const sw = handles.find(h => h.id === 'sw');
      const rot = handles.find(h => h.id === 'rotate');

      // Caixa delimitadora transformada
      octx.save();
      octx.strokeStyle = '#04d361';
      octx.lineWidth = 1.5;
      octx.setLineDash([4, 3]);
      octx.beginPath();
      octx.moveTo(nw.x, nw.y);
      octx.lineTo(ne.x, ne.y);
      octx.lineTo(se.x, se.y);
      octx.lineTo(sw.x, sw.y);
      octx.closePath();
      octx.stroke();

      // Haste da alça de rotação
      if (rot) {
        octx.setLineDash([]);
        octx.strokeStyle = '#f43f5e';
        octx.beginPath();
        octx.moveTo(rot.anchorX, rot.anchorY);
        octx.lineTo(rot.x, rot.y);
        octx.stroke();
      }

      // Desenha cada alça
      octx.setLineDash([]);
      for (const h of handles) {
        octx.fillStyle = h.color;
        octx.strokeStyle = '#121214';
        octx.lineWidth = 2;
        if (h.shape === 'circle') {
          octx.beginPath();
          octx.arc(h.x, h.y, 7, 0, Math.PI * 2);
          octx.fill();
          octx.stroke();
        } else if (h.shape === 'diamond') {
          octx.beginPath();
          octx.moveTo(h.x, h.y - 6);
          octx.lineTo(h.x + 6, h.y);
          octx.lineTo(h.x, h.y + 6);
          octx.lineTo(h.x - 6, h.y);
          octx.closePath();
          octx.fill();
          octx.stroke();
        } else {
          octx.fillRect(h.x - 5.5, h.y - 5.5, 11, 11);
          octx.strokeRect(h.x - 5.5, h.y - 5.5, 11, 11);
        }
      }
      octx.restore();
    }

    // Interação de ponteiro nas alças
    let activeHandle = null;
    let dragStart = null;

    function hitTestHandle(clientX, clientY) {
      if (!selState.active || !selState.transformMode) return null;
      const cRect = canvas.getBoundingClientRect();
      const px = clientX - cRect.left;
      const py = clientY - cRect.top;
      const handles = getHandlesScreenPositions();
      // Prioriza rotação e shear, depois cantos e lados
      for (let i = handles.length - 1; i >= 0; i--) {
        const h = handles[i];
        if (Math.hypot(px - h.x, py - h.y) <= 16) return h.id;
      }
      return null;
    }

    function beginHandleDrag(handleId, gx, gy) {
      activeHandle = handleId;
      const cx = selState.baseX + selState.baseW / 2 + selState.tx;
      const cy = selState.baseY + selState.baseH / 2 + selState.ty;
      dragStart = {
        gx, gy,
        tx: selState.tx, ty: selState.ty,
        scaleX: selState.scaleX, scaleY: selState.scaleY,
        angle: selState.angle,
        skewX: selState.skewX, skewY: selState.skewY,
        startAngle: Math.atan2(gy - cy, gx - cx)
      };
    }

    function updateHandleDrag(gx, gy, shiftKey = false) {
      if (!activeHandle || !dragStart) return;
      const cx = selState.baseX + selState.baseW / 2 + dragStart.tx;
      const cy = selState.baseY + selState.baseH / 2 + dragStart.ty;
      const hw = Math.max(0.5, selState.baseW / 2);
      const hh = Math.max(0.5, selState.baseH / 2);

      // Vetor do centro até o cursor rotacionado de volta para os eixos locais
      const dx = gx - cx;
      const dy = gy - cy;
      const cos = Math.cos(-dragStart.angle);
      const sin = Math.sin(-dragStart.angle);
      const lx = dx * cos - dy * sin;
      const ly = dx * sin + dy * cos;

      if (activeHandle === 'rotate') {
        const curAng = Math.atan2(gy - cy, gx - cx);
        let newAng = dragStart.angle + (curAng - dragStart.startAngle);
        if (shiftKey) {
          const step = Math.PI / 12; // 15 graus
          newAng = Math.round(newAng / step) * step;
        }
        selState.angle = newAng;
      } else if (activeHandle === 'shearX') {
        const deltaLx = lx - (dragStart.gx - cx) * cos + (dragStart.gy - cy) * sin;
        selState.skewX = Math.max(-2.5, Math.min(2.5, dragStart.skewX + deltaLx / Math.max(1, hh * Math.abs(dragStart.scaleY))));
      } else if (activeHandle === 'shearY') {
        const deltaLy = ly - (dragStart.gx - cx) * sin - (dragStart.gy - cy) * cos;
        selState.skewY = Math.max(-2.5, Math.min(2.5, dragStart.skewY + deltaLy / Math.max(1, hw * Math.abs(dragStart.scaleX))));
      } else {
        // Alças de Escala (com espelhamento automático ao cruzar o eixo oposto!)
        const signX = activeHandle.includes('w') ? -1 : (activeHandle.includes('e') ? 1 : 0);
        const signY = activeHandle.includes('n') ? -1 : (activeHandle.includes('s') ? 1 : 0);

        let newScaleX = dragStart.scaleX;
        let newScaleY = dragStart.scaleY;

        if (signX !== 0) newScaleX = (lx * signX) / hw;
        if (signY !== 0) newScaleY = (ly * signY) / hh;

        // Cantos mantêm proporção (preservando o sinal de espelhamento de cada eixo)
        if (signX !== 0 && signY !== 0) {
          const mag = Math.max(Math.abs(newScaleX), Math.abs(newScaleY));
          newScaleX = (newScaleX < 0 ? -1 : 1) * mag;
          newScaleY = (newScaleY < 0 ? -1 : 1) * mag;
        }

        selState.scaleX = newScaleX;
        selState.scaleY = newScaleY;
      }

      const flipInfo = `${selState.scaleX < 0 ? ' [Espelho H]' : ''}${selState.scaleY < 0 ? ' [Espelho V]' : ''}`;
      updateStatus(Math.round(gx), Math.round(gy), `Escala: ${Math.round(selState.scaleX * 100)}%×${Math.round(selState.scaleY * 100)}% | Ângulo: ${Math.round(selState.angle * 180 / Math.PI)}°${flipInfo}`);
      render();
    }

    function endHandleDrag() {
      activeHandle = null;
      dragStart = null;
    }

    return {
      state: selState,
      commit,
      clear,
      applyMask,
      applyHeterogeneousTargets,
      getTransformedClipFor,
      getActiveFrameMask,
      drawOverlay,
      hitTestHandle,
      beginHandleDrag,
      updateHandleDrag,
      endHandleDrag,
      isDraggingHandle: () => Boolean(activeHandle),
      isPointInside: (gx, gy) => {
        const mask = getActiveFrameMask();
        if (!mask) return false;
        const ix = Math.floor(gx), iy = Math.floor(gy);
        if (ix < 0 || ix >= state.gridW || iy < 0 || iy >= state.gridH) return false;
        return mask[iy * state.gridW + ix] === 1;
      },
      translateBy: (dx, dy) => {
        selState.tx += dx;
        selState.ty += dy;
        render();
      },
      resetTransform: () => {
        selState.tx = 0; selState.ty = 0;
        selState.scaleX = 1; selState.scaleY = 1;
        selState.angle = 0;
        selState.skewX = 0; selState.skewY = 0;
        render();
      },
      flipHorizontal: () => { selState.scaleX *= -1; render(); },
      flipVertical: () => { selState.scaleY *= -1; render(); },
      rotate90: () => { selState.angle += Math.PI / 2; render(); }
    };
  };
})();
