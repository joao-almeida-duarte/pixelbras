# PixelBras

Editor de **Pixel Art e Animação** focado em performance (WebGL), precisão pixel-perfect e fluxos de trabalho avançados para desktop e dispositivos touch.

👉 **Acesse online:** [https://joao-almeida-duarte.github.io/pixelbras/](https://joao-almeida-duarte.github.io/pixelbras/)

![Visão Geral do PixelBras](docs/screenshot-overview.png)
<!-- Placeholder: adicione aqui um print geral da interface em uso -->

---

## Principais Recursos

* **Renderização WebGL (Nearest-Neighbor):** Zoom nítido sem borrão, grade opcional e suporte a *Onion Skin* (papel manteiga) para animação.
* **Ferramentas de Desenho:** Pincel (com tamanhos e formatos configuráveis), Borracha, Linha, Retângulo, Balde de Tinta, Conta-Gotas e Varinha Mágica.
* **Seleção Arbitrária com Máscara Real:** Retângulo, Laço Livre e Pincel de Seleção com modos **Nova**, **+ Adicionar** e **- Remover** (com preview vermelho para subtração).
* **Motor de Transformação 2D (`transform-engine.js`):**
  * **Mover, Ampliar/Reduzir** (cantos proporcionais e laterais H/V com **espelhamento automático** ao cruzar o limite oposto).
  * **Girar** livremente (ou em passos de 15° segurando `Shift`) e **Shear** (inclinação horizontal/vertical).
  * **Fulcro / Pivô Móvel (`⊕`):** Arraste o centro de transformação para qualquer ponto dentro ou fora da seleção.
  * **Clonar no lugar** e **Repetir `N` vezes (`↻ Repetir`):** Ideal para criar rosáceas, espirais e padrões repetitivos sem perda de nitidez.
* **Camadas e Timeline de Animação:**
  * Controle de FPS, Play/Pause e *Onion Skin*.
  * Seleção múltipla (**Multi** ou `Ctrl`/`Shift`) para **reordenar** (`↑/↓`, `←/→`), **clonar grupos** e **espelhar a ordem** (`⇄`) tanto de camadas quanto de quadros.
* **Grupos Heterogêneos & Máscaras Bitmask (`mask-groups.js`):**
  * Armazenamento compacto de máscaras em campo de bits (`Uint32Array`).
  * **Modo Complexo (`ON/OFF`):** Crie grupos nomeados combinando qualquer `Quadro × Camada` com máscaras individuais.
  * **Desenho Restrito:** Quando um grupo está ativo, as ferramentas de desenho respeitam a máscara do quadro/camada atual mesmo ao alternar entre eles.
  * **Copiar/Colar entre Grupos (Origem → Destino):** Com modos memorizados para tamanhos diferentes (**Loop**, **Hold**, **1-para-1**) e recorte pela máscara de destino.
* **Interface Responsiva:** Barras roláveis horizontalmente (suporte a toque no mobile e rodinha do mouse no desktop) e proteção de gestos de 2 dedos para zoom/pan.

---

## Manual Rápido de Uso

### 1. Desenho e Pincéis
1. Selecione o **Pincel** ou a **Borracha** na barra superior.
2. Clique novamente no ícone do **Pincel** (ou **Pincel de Seleção**) para abrir o painel de tamanho e formato.
3. No celular/tablet, use **2 dedos** para dar zoom ou mover a tela sem riscar o desenho.

![Ferramentas de Desenho e Pincéis](docs/screenshot-drawing.png)
<!-- Placeholder: print mostrando o painel de pincéis e desenho no canvas -->

### 2. Seleção e Transformação 2D
1. Escolha **Seleção Retangular**, **Laço Livre (`O`)** ou **Pincel de Seleção (`S`)**.
2. Na barra verde contextual, alterne entre **Nova**, **+ Add** e **- Sub** para refinar a máscara.
3. Clique em **`⤢ Transformar`** para exibir as alças:
   * **Verdes (Cantos):** Escala proporcional (cruze o centro para espelhar).
   * **Azuis (Laterais):** Escala horizontal/vertical (cruze o lado oposto para espelhar).
   * **Vermelha (Topo):** Rotação (segure `Shift` no PC para travar de 15° em 15°).
   * **Laranjas (Losangos):** Shear / Inclinação.
   * **Mira Amarela (`⊕`):** Fulcro / Pivô de transformação.
4. **Criando Rosáceas ou Padrões:** Selecione uma forma → clique em **`Clonar`** → posicione o fulcro **`⊕`** → gire ou desloque → defina a quantidade e clique em **`↻ Repetir`**.
5. Clique em **`Fixar`** para gravar o resultado na camada.

![Motor de Transformação e Fulcro](docs/screenshot-transform.png)
<!-- Placeholder: print com alças de transformação e fulcro visíveis -->

### 3. Camadas e Animação
1. Abra o painel de **Camadas** ou a **Timeline de Animação**.
2. Ative **`Multi`** (ou segure `Ctrl` no PC) para marcar vários quadros ou camadas.
3. Use as setas para mover o bloco, **`Clonar`** para duplicar a sequência ou **`⇄`** para inverter a ordem (útil para animações de ida e volta).

![Timeline de Animação e Camadas](docs/screenshot-animation.png)
<!-- Placeholder: print da timeline de animação e painel de camadas -->

### 4. Modo Complexo: Grupos & Máscaras Bitmask
1. Clique no ícone **`🗂️`** no cabeçalho para abrir o gerenciador.
2. Ligue o **`Modo Complexo: ON`** quando quiser trabalhar com grupos persistentes (deixe **OFF** para o fluxo direto onde a seleção da tela prevalece).
3. Salve seleções na **Biblioteca de Máscaras** (salvas localmente no navegador), monte grupos com combinações livres de `Quadro × Camada` e transfira conteúdo de um **Grupo de Origem** para um **Grupo de Destino**.

![Modal de Grupos e Máscaras Bitmask](docs/screenshot-groups.png)
<!-- Placeholder: print do modal de Grupos & Máscaras -->

---

## Atalhos de Teclado (Desktop)

| Tecla | Ação |
|---|---|
| `O` | Seleção por Laço Livre |
| `S` | Seleção em Pincel |
| `Shift` (ao girar) | Trava rotação em passos de 15° |
| `Ctrl` / `Shift` + Clique | Seleção múltipla de quadros e camadas |
| Rodinha do Mouse (nas barras) | Rolagem horizontal das barras de ferramentas |

---

## Estrutura do Projeto

```text
pixelbras/
├── index.html          # Interface principal, WebGL renderer e ferramentas de desenho
├── transform-engine.js # Motor matricial 2D, alças no workspace, fulcro móvel e repetição N×
├── mask-groups.js      # BitMask2D (Uint32Array), grupos nomeados e persistência localStorage
├── thumbnail.jpg       # Miniatura Open Graph / compartilhamento
└── docs/               # Pasta reservada para capturas de tela do manual
```

---

## Rodando Localmente

Não requer instalação de dependências ou build:

```bash
git clone https://github.com/joao-almeida-duarte/pixelbras.git
cd pixelbras
python3 -m http.server 8000
```

Acesse `http://127.0.0.1:8000` no navegador.
