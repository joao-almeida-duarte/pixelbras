// =========================================================================
// MOTOR ABSTRATO DE SELEÇÃO, FULCRO MÓVEL E TRANSFORMAÇÃO 2D
// =========================================================================
(function () {
  window.createSelectionTransformEngine = function (deps) {
    const {
      state, canvas, workspace,
      getActiveFrame, getActiveLayer, getActivePixels,
      getSelectedFrames, getSelectedLayers,
      saveState, render, updateStatus, setPixelRaw, getPixel
    } = deps;

    const selState = {
      active: false,
      mode: 'replace',       // 'replace' | 'add' | 'sub'
      transformMode: false,
      baseX: 0,
      baseY: 0,
      baseW: 0,
      baseH: 0,
      // Fulcro / Pivô em coordenadas locais relativas ao centro (baseW/2, baseH/2)
      pivotX: 0,
      pivotY: 0,
      // Parâmetros de transformação
      tx: 0,
      ty: 0,
      scaleX: 1,
      scaleY: 1,
      angle: 0,
      skewX: 0,
      skewY: 0,
      clips: []
    };

    // Área de transferência rápida e memória do passo para "Repetir"
    let quickClipboard = null; // { baseW, baseH, data: Uint8Array, mask: Uint8Array }
    let lastRepeatStep = null; // { tx, ty, scaleX, scaleY, angle, skewX, skewY }

    const overlay = document.createElement('canvas');
    overlay.id = 'transformOverlay';
    overlay.style.position = 'absolute';
    overlay.style.pointerEvents = 'none';
    overlay.style.zIndex = '15';
    workspace.appendChild(overlay);
    const octx = overlay.getContext('2d');

    function syncOverlayBounds() {
      const wRect = workspace.getBoundingClientRect();
      overlay.style.left = '0px';
      overlay.style.top = '0px';
      overlay.width = Math.max(1, Math.round(wRect.width));
      overlay.height = Math.max(1, Math.round(wRect.height));
      overlay.style.width = wRect.width + 'px';
      overlay.style.height = wRect.height + 'px';
    }

    // Mapeia ponto local (relativo ao centro do clip) -> coordenada do grid usando o Fulcro (pivotX, pivotY)
    function localToGrid(lx, ly) {
      const cx = selState.baseX + selState.baseW / 2 + selState.tx + selState.pivotX;
      const cy = selState.baseY + selState.baseH / 2 + selState.ty + selState.pivotY;

      // Relativo ao fulcro
      let x = (lx - selState.pivotX) * selState.scaleX;
      let y = (ly - selState.pivotY) * selState.scaleY;

      // Shear
      const sx = x + y * selState.skewX;
      const sy = y + x * selState.skewY;

      // Rotação
      const cos = Math.cos(selState.angle);
      const sin = Math.sin(selState.angle);
      const rx = sx * cos - sy * sin;
      const ry = sx * sin + sy * cos;

      return [cx + rx, cy + ry];
    }

    // Inversa exata: coordenada do grid -> ponto local original
    function gridToLocal(gx, gy) {
      const cx = selState.baseX + selState.baseW / 2 + selState.tx + selState.pivotX;
      const cy = selState.baseY + selState.baseH / 2 + selState.ty + selState.pivotY;
      const dx = gx - cx;
      const dy = gy - cy;

      const cos = Math.cos(-selState.angle);
      const sin = Math.sin(-selState.angle);
      const rx = dx * cos - dy * sin;
      const ry = dx * sin + dy * cos;

      const det = 1 - selState.skewX * selState.skewY;
      const safeDet = Math.abs(det) < 1e-4 ? (det < 0 ? -1e-4 : 1e-4) : det;
      const ux = (rx - ry * selState.skewX) / safeDet;
      const uy = (ry - rx * selState.skewY) / safeDet;

      const sX = Math.abs(selState.scaleX) < 1e-3 ? (selState.scaleX < 0 ? -1e-3 : 1e-3) : selState.scaleX;
      const sY = Math.abs(selState.scaleY) < 1e-3 ? (selState.scaleY < 0 ? -1e-3 : 1e-3) : selState.scaleY;

      return [ux / sX + selState.pivotX, uy / sY + selState.pivotY];
    }

    // Move o fulcro para uma posição do grid mantendo os pixels visualmente parados no mesmo lugar
    function movePivotToGrid(gx, gy) {
      const [newPivotX, newPivotY] = gridToLocal(gx, gy);
      const [oldOriginGx, oldOriginGy] = localToGrid(0, 0);
      selState.pivotX = newPivotX;
      selState.pivotY = newPivotY;
      const [newOriginGx, newOriginGy] = localToGrid(0, 0);
      selState.tx += (oldOriginGx - newOriginGx);
      selState.ty += (oldOriginGy - newOriginGy);
    }

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

    function getTargetTargets() {
      const framesIdx = getSelectedFrames();
      const layersIdx = getSelectedLayers();
      const targets = [];

      for (const fIdx of framesIdx) {
        const fr = state.frames[fIdx];
        if (!fr) continue;
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
      selState.pivotX = 0; selState.pivotY = 0;
      selState.tx = 0; selState.ty = 0;
      selState.scaleX = 1; selState.scaleY = 1;
      selState.angle = 0;
      selState.skewX = 0; selState.skewY = 0;
      lastRepeatStep = null;
      state.selection = null;
      drawOverlay();
    }

    function applyMask(newMask) {
      const prevFullMask = new Uint8Array(state.gridW * state.gridH);
      if (selState.active && selState.clips.length > 0) {
        const refSample = sampleClipToGrid(selState.clips[0]);
        prevFullMask.set(refSample.mask);

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
      selState.baseX = minX; selState.baseY = minY;
      selState.baseW = w; selState.baseH = h;
      selState.pivotX = 0; selState.pivotY = 0;
      selState.tx = 0; selState.ty = 0;
      selState.scaleX = 1; selState.scaleY = 1;
      selState.angle = 0;
      selState.skewX = 0; selState.skewY = 0;
      selState.clips = newClips;
      state.selection = selState;

      render();
    }

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
      selState.baseX = minX; selState.baseY = minY;
      selState.baseW = w; selState.baseH = h;
      selState.pivotX = 0; selState.pivotY = 0;
      selState.tx = 0; selState.ty = 0;
      selState.scaleX = 1; selState.scaleY = 1;
      selState.angle = 0;
      selState.skewX = 0; selState.skewY = 0;
      selState.clips = newClips;
      state.selection = selState;
    }

    // Copiar / Colar / Clonar rápido da seleção atual
    function copyQuickSelection() {
      if (!selState.active || selState.clips.length === 0) return false;
      const fr = getActiveFrame();
      const clip = selState.clips.find(c => c.frameIdx === state.activeFrameIdx && c.layerIdx === fr.activeLayerIdx) || selState.clips[0];
      quickClipboard = {
        baseX: selState.baseX, baseY: selState.baseY,
        baseW: selState.baseW, baseH: selState.baseH,
        data: new Uint8Array(clip.data),
        mask: new Uint8Array(clip.mask)
      };
      updateStatus(0, 0, '📋 Seleção copiada!');
      return true;
    }

    function pasteQuickSelection(offsetX = 0, offsetY = 0) {
      if (!quickClipboard) return false;
      commit();
      saveState();
      const fr = getActiveFrame();
      selState.active = true;
      selState.baseX = quickClipboard.baseX;
      selState.baseY = quickClipboard.baseY;
      selState.baseW = quickClipboard.baseW;
      selState.baseH = quickClipboard.baseH;
      selState.pivotX = 0; selState.pivotY = 0;
      selState.tx = offsetX; selState.ty = offsetY;
      selState.scaleX = 1; selState.scaleY = 1;
      selState.angle = 0;
      selState.skewX = 0; selState.skewY = 0;
      selState.clips = [{
        frameIdx: state.activeFrameIdx,
        layerIdx: fr.activeLayerIdx,
        data: new Uint8Array(quickClipboard.data),
        mask: new Uint8Array(quickClipboard.mask)
      }];
      state.selection = selState;
      render();
      return true;
    }

    function cloneQuickSelection() {
      if (!selState.active) return false;
      // Grava a cópia original nos pixels e mantém a cópia flutuante deslocada 1px para arrastar
      saveState();
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
      lastRepeatStep = null;
      updateStatus(0, 0, '⧉ Seleção clonada no lugar! Transforme ou arraste livremente.');
      render();
      return true;
    }

    // Grava o estado atual na camada e reaplica o mesmo passo de transformação (ideal para rosáceas e padrões)
    function repeatTransform(times = 1) {
      if (!selState.active || selState.clips.length === 0) return false;
      const n = Math.max(1, Math.min(64, parseInt(times, 10) || 1));

      if (!lastRepeatStep) {
        const hasDelta = (
          Math.abs(selState.tx) > 1e-4 || Math.abs(selState.ty) > 1e-4 ||
          Math.abs(selState.angle) > 1e-4 ||
          Math.abs(selState.scaleX - 1) > 1e-4 || Math.abs(selState.scaleY - 1) > 1e-4 ||
          Math.abs(selState.skewX) > 1e-4 || Math.abs(selState.skewY) > 1e-4
        );
        if (!hasDelta) {
          updateStatus(0, 0, '⚠️ Mova, gire ou escale a seleção antes de clicar em Repetir.');
          return false;
        }
        lastRepeatStep = {
          tx: selState.tx,
          ty: selState.ty,
          scaleX: selState.scaleX,
          scaleY: selState.scaleY,
          angle: selState.angle,
          skewX: selState.skewX,
          skewY: selState.skewY
        };
      }

      saveState();

      for (let step = 0; step < n; step++) {
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

        selState.tx += lastRepeatStep.tx;
        selState.ty += lastRepeatStep.ty;
        selState.angle += lastRepeatStep.angle;
        selState.scaleX *= lastRepeatStep.scaleX;
        selState.scaleY *= lastRepeatStep.scaleY;
        selState.skewX += lastRepeatStep.skewX;
        selState.skewY += lastRepeatStep.skewY;
      }

      updateStatus(0, 0, `↻ Repetido ${n}×! Ângulo: ${Math.round(selState.angle * 180 / Math.PI)}° | Escala: ${Math.round(selState.scaleX * 100)}%`);
      render();
      return true;
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
    // ALÇAS DE TRANSFORMAÇÃO + ALÇA DO FULCRO (PIVOT)
    // =====================================================================
    function getHandlesScreenPositions() {
      if (!selState.active || !selState.transformMode) return [];
      syncOverlayBounds();
      const wRect = workspace.getBoundingClientRect();
      const cRect = canvas.getBoundingClientRect();
      const offX = cRect.left - wRect.left;
      const offY = cRect.top - wRect.top;
      const scaleXpx = cRect.width / state.gridW;
      const scaleYpx = cRect.height / state.gridH;
      const hw = selState.baseW / 2;
      const hh = selState.baseH / 2;

      const toScreen = (lx, ly) => {
        const [gx, gy] = localToGrid(lx, ly);
        return { x: offX + gx * scaleXpx, y: offY + gy * scaleYpx };
      };

      const handles = [
        { id: 'nw', lx: -hw, ly: -hh, color: '#04d361', shape: 'rect' },
        { id: 'ne', lx:  hw, ly: -hh, color: '#04d361', shape: 'rect' },
        { id: 'se', lx:  hw, ly:  hh, color: '#04d361', shape: 'rect' },
        { id: 'sw', lx: -hw, ly:  hh, color: '#04d361', shape: 'rect' },
        { id: 'n',  lx:   0, ly: -hh, color: '#38bdf8', shape: 'rect' },
        { id: 's',  lx:   0, ly:  hh, color: '#38bdf8', shape: 'rect' },
        { id: 'w',  lx: -hw, ly:   0, color: '#38bdf8', shape: 'rect' },
        { id: 'e',  lx:  hw, ly:   0, color: '#38bdf8', shape: 'rect' },
        { id: 'shearX', lx: 0, ly: -hh * 0.55, color: '#f59e0b', shape: 'diamond' },
        { id: 'shearY', lx: hw * 0.55, ly: 0,  color: '#f59e0b', shape: 'diamond' }
      ];

      const mapped = handles.map(h => ({ ...h, ...toScreen(h.lx, h.ly) }));

      // Alça de Rotação
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

      // Alça do Fulcro (Pivô) por último (prioridade de clique!)
      const piv = toScreen(selState.pivotX, selState.pivotY);
      mapped.push({
        id: 'pivot',
        x: piv.x,
        y: piv.y,
        color: '#fde047',
        shape: 'pivot'
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

      if (rot) {
        octx.setLineDash([]);
        octx.strokeStyle = '#f43f5e';
        octx.beginPath();
        octx.moveTo(rot.anchorX, rot.anchorY);
        octx.lineTo(rot.x, rot.y);
        octx.stroke();
      }

      octx.setLineDash([]);
      for (const h of handles) {
        if (h.shape === 'pivot') {
          // Desenha mira do Fulcro (⊕)
          octx.beginPath();
          octx.arc(h.x, h.y, 7, 0, Math.PI * 2);
          octx.fillStyle = 'rgba(253, 224, 71, 0.25)';
          octx.fill();
          octx.lineWidth = 2;
          octx.strokeStyle = '#fde047';
          octx.stroke();
          octx.beginPath();
          octx.moveTo(h.x - 10, h.y); octx.lineTo(h.x + 10, h.y);
          octx.moveTo(h.x, h.y - 10); octx.lineTo(h.x, h.y + 10);
          octx.stroke();
        } else if (h.shape === 'circle') {
          octx.fillStyle = h.color;
          octx.strokeStyle = '#121214';
          octx.lineWidth = 2;
          octx.beginPath();
          octx.arc(h.x, h.y, 7, 0, Math.PI * 2);
          octx.fill();
          octx.stroke();
        } else if (h.shape === 'diamond') {
          octx.fillStyle = h.color;
          octx.strokeStyle = '#121214';
          octx.lineWidth = 2;
          octx.beginPath();
          octx.moveTo(h.x, h.y - 6);
          octx.lineTo(h.x + 6, h.y);
          octx.lineTo(h.x, h.y + 6);
          octx.lineTo(h.x - 6, h.y);
          octx.closePath();
          octx.fill();
          octx.stroke();
        } else {
          octx.fillStyle = h.color;
          octx.strokeStyle = '#121214';
          octx.lineWidth = 2;
          octx.fillRect(h.x - 5.5, h.y - 5.5, 11, 11);
          octx.strokeRect(h.x - 5.5, h.y - 5.5, 11, 11);
        }
      }
      octx.restore();
    }

    let activeHandle = null;
    let dragStart = null;

    function hitTestHandle(clientX, clientY) {
      if (!selState.active || !selState.transformMode) return null;
      const wRect = workspace.getBoundingClientRect();
      const px = clientX - wRect.left;
      const py = clientY - wRect.top;
      const handles = getHandlesScreenPositions();
      for (let i = handles.length - 1; i >= 0; i--) {
        const h = handles[i];
        if (Math.hypot(px - h.x, py - h.y) <= 16) return h.id;
      }
      return null;
    }

    function beginHandleDrag(handleId, gx, gy) {
      lastRepeatStep = null;
      activeHandle = handleId;
      const [pivGx, pivGy] = localToGrid(selState.pivotX, selState.pivotY);
      dragStart = {
        gx, gy, pivGx, pivGy,
        tx: selState.tx, ty: selState.ty,
        scaleX: selState.scaleX, scaleY: selState.scaleY,
        angle: selState.angle,
        skewX: selState.skewX, skewY: selState.skewY,
        startAngle: Math.atan2(gy - pivGy, gx - pivGx)
      };
    }

    function updateHandleDrag(gx, gy, shiftKey = false) {
      if (!activeHandle || !dragStart) return;

      if (activeHandle === 'pivot') {
        movePivotToGrid(gx, gy);
        updateStatus(Math.round(gx), Math.round(gy), `⊕ Fulcro movido para (${Math.round(gx)}, ${Math.round(gy)})`);
        render();
        return;
      }

      const pivGx = dragStart.pivGx;
      const pivGy = dragStart.pivGy;
      const hw = Math.max(0.5, selState.baseW / 2);
      const hh = Math.max(0.5, selState.baseH / 2);

      const dx = gx - pivGx;
      const dy = gy - pivGy;
      const cos = Math.cos(-dragStart.angle);
      const sin = Math.sin(-dragStart.angle);
      const lx = dx * cos - dy * sin;
      const ly = dx * sin + dy * cos;

      if (activeHandle === 'rotate') {
        const curAng = Math.atan2(gy - pivGy, gx - pivGx);
        let newAng = dragStart.angle + (curAng - dragStart.startAngle);
        if (shiftKey) {
          const step = Math.PI / 12;
          newAng = Math.round(newAng / step) * step;
        }
        selState.angle = newAng;
      } else if (activeHandle === 'shearX') {
        const deltaLx = lx - ((dragStart.gx - pivGx) * cos - (dragStart.gy - pivGy) * sin);
        selState.skewX = Math.max(-2.5, Math.min(2.5, dragStart.skewX + deltaLx / Math.max(1, hh * Math.abs(dragStart.scaleY))));
      } else if (activeHandle === 'shearY') {
        const deltaLy = ly - ((dragStart.gx - pivGx) * sin + (dragStart.gy - pivGy) * cos);
        selState.skewY = Math.max(-2.5, Math.min(2.5, dragStart.skewY + deltaLy / Math.max(1, hw * Math.abs(dragStart.scaleX))));
      } else {
        const signX = activeHandle.includes('w') ? -1 : (activeHandle.includes('e') ? 1 : 0);
        const signY = activeHandle.includes('n') ? -1 : (activeHandle.includes('s') ? 1 : 0);

        const refDistX = Math.max(0.5, Math.abs((signX * hw) - selState.pivotX));
        const refDistY = Math.max(0.5, Math.abs((signY * hh) - selState.pivotY));

        let newScaleX = dragStart.scaleX;
        let newScaleY = dragStart.scaleY;

        if (signX !== 0) newScaleX = (lx * signX) / refDistX;
        if (signY !== 0) newScaleY = (ly * signY) / refDistY;

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
      copyQuickSelection,
      pasteQuickSelection,
      cloneQuickSelection,
      repeatTransform,
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
        lastRepeatStep = null;
        selState.tx += dx;
        selState.ty += dy;
        render();
      },
      resetTransform: () => {
        selState.pivotX = 0; selState.pivotY = 0;
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
