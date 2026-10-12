// ===== 侧栏展开/收缩 =====
// 图标切换由 CSS 兄弟选择器完成，JS 只负责切换状态
const sidebar = document.getElementById('sidebar');
const toggleBtn = document.getElementById('sidebar-toggle');

function toggleSidebar() {
    sidebar.classList.toggle('collapsed');
}

toggleBtn.addEventListener('click', toggleSidebar);

// ===== 图片列表加载与排版 =====
const app = document.getElementById('app');
const viewer = document.getElementById('viewer');
const emptyHint = document.getElementById('empty-hint');
const emptyImage = document.getElementById('empty-image');

function renderImageStrip(items) {
    viewer.querySelector('#image-strip')?.remove(); // 清空旧图片条

    const strip = document.createElement('div');
    strip.id = 'image-strip';

    for (const item of items) {
        const img = document.createElement('img');
        img.src = item.url;
        img.loading = 'lazy'; // 浏览器原生懒加载
        img.alt = item.name;
        img.draggable = false; // 禁原生“拖图片”，左键拖拽按设定执行拖动或缩放（配合 CSS user-drag:none）
        img.dataset.name = item.name;
        // 预设宽高比：未解码时高度也正确，滚动定位与缩放锚定不漂移
        img.style.aspectRatio = `${item.width} / ${item.height}`;
        strip.appendChild(img);
    }

    emptyHint.style.display = 'none';
    if (emptyImage) emptyImage.style.display = 'none';   // 空态提示图与文字同进同退
    viewer.appendChild(strip);
    viewer.classList.add('has-images');
    syncScrollUi();
}

// 单击侧栏缩略图时由 sidebar.js 调用：加载该目录图片并跳到指定图片顶部。
// 同目录点击：不彻底停播——跳转后走“暂停-自动恢复”机制（与翻页同款），
//   短暂静置后从新图片顶部继续播放；跨目录：视为内容重置，维持原样彻底停止。
let currentDirPath = null; // 主区当前展示的目录（由缩略图点击写入）

// 预加载单张图：把目标图字节先拉进浏览器缓存，之后 renderImageStrip 新建的同 src <img> 会立即 complete。
// 目的：跳转前目标图尚未下载（跨目录、或同目录跳到从未进过视口的远处懒加载图）时，
// 重建整条后立刻滚过去会空一帧（闪烁）；预加载让旧内容一直显示到目标就绪，替换瞬间直接画出、不闪。
// 已缓存的近处跳转几乎瞬时 resolve，不额外等待；加载失败(onerror)也 resolve，绝不卡在旧内容上。
function preloadImage(url) {
    return new Promise((resolve) => {
        const im = new Image();
        im.onload = () => resolve();
        im.onerror = () => resolve();
        im.src = url;
    });
}

async function openImagesAt(dirPath, imageName) {
    if (dirPath === currentDirPath) {
        pauseAutoScroll();   // 同目录：短暂让位，跳转落定后自动续播（未播放时空转）
    } else {
        stopAutoScroll();    // 跨目录：内容重置，彻底停止播放
    }
    const items = await MockAPI.listImages(dirPath);
    if (!items.length) return;

    // 先把「要点开的那张」预加载好再重建整条：跨目录 / 同目录远跳都不再闪（目标已在缓存）。
    const targetItem = items.find((x) => x.name === imageName);
    if (targetItem) await preloadImage(targetItem.url);

    renderImageStrip(items);
    currentDirPath = dirPath;

    const target = getImageElements().find((el) => el.dataset.name === imageName);
    if (target) {
        // 宽高比已预设，读布局即得正确位置，直接瞬移对齐视口顶部
        const viewerTop = viewer.getBoundingClientRect().top;
        viewer.scrollTop += target.getBoundingClientRect().top - viewerTop;
    }
    syncScrollUi();
}

// ===== 页码指示（预览区右上角，悬浮于图片上方） =====
// 当前位置 = 顶部已越过视口中心水平线的图片张数。
// 例：a b c…，b 的头未越过中心线→只有 a 越过→显示 1/N；
//     b 越过而 c 未越过→显示 2/N，以此类推。
const pageIndicator = document.getElementById('page-indicator');

function updatePageIndicator() {
    const imgs = getImageElements();
    if (!imgs.length || app.classList.contains('hide-extra-ui')) {
        pageIndicator.style.display = 'none';
        return;
    }
    const viewerRect = viewer.getBoundingClientRect();
    const centerY = viewerRect.top + viewerRect.height * 0.25;
    let current = 0;
    for (const img of imgs) {
        if (img.getBoundingClientRect().top < centerY) current++;
    }
    if (current < 1) current = 1;               // 首张头尚未越过中心线时仍算第 1 张
    if (current > imgs.length) current = imgs.length;
    pageIndicator.textContent = `${current}/${imgs.length}`;
    pageIndicator.style.display = 'block';
}

// 滚动时实时更新：rAF 节流，避免每个滚动像素都全量测量各图位置
let pageIndicatorRaf = null;
viewer.addEventListener('scroll', () => {
    if (pageIndicatorRaf !== null) return;
    pageIndicatorRaf = requestAnimationFrame(() => {
        pageIndicatorRaf = null;
        syncScrollUi();
    });
}, { passive: true });

// ===== 悬浮滚动条（覆盖在图片右缘之上，不占用布局宽度）=====
// 原生 ::-webkit-scrollbar 会预留宽度（即图片放到最大时右侧的黑边），无法浮动。
// 做法：隐藏 viewer 原生滚动条（仍保留 overflow-y 滚动能力），用一个绝对定位的自定义条覆盖。
const vScrollbar = document.getElementById('vscrollbar');
const vThumb = vScrollbar.querySelector('.thumb');

function updateVScrollbar() {
    const { scrollTop, scrollHeight, clientHeight } = viewer;
    const overflow = scrollHeight - clientHeight;
    if (overflow <= 1) {                       // 内容未超出：无需滚动条，隐藏
        vScrollbar.classList.remove('active');
        return;
    }
    vScrollbar.classList.add('active');
    const trackH = vScrollbar.clientHeight;    // 轨道高（= viewer 可视高）
    const thumbH = Math.max(30, trackH * (clientHeight / scrollHeight));
    const maxTop = trackH - thumbH;
    vThumb.style.height = `${thumbH}px`;
    vThumb.style.top = `${(scrollTop / overflow) * maxTop}px`;
}

// 统一刷新与滚动/布局相关的悬浮 UI（页码 + 悬浮滚动条）
function syncScrollUi() {
    updatePageIndicator();
    updateVScrollbar();
    // 进度条弹出时随滚动 / 布局变化实时跟随现实（拖动滑块、输入页码期间不干预，避免打架）
    if (pageJump && pageJump.classList.contains('show')
        && !pageJumpDragging && !pageJumpEditing) {
        refreshPageJumpFollow();
    }
}

// 拖动滑块：直接映射到 viewer.scrollTop（scrollTop 变动会触发 scroll 事件回报位置）
let vsbDragging = false;
let vsbStartY = 0;
let vsbStartScroll = 0;

function onVThumbDrag(e) {
    if (!vsbDragging) return;
    const trackH = vScrollbar.clientHeight;
    const maxTop = trackH - vThumb.offsetHeight;
    const overflow = viewer.scrollHeight - viewer.clientHeight;
    if (maxTop <= 0) return;
    viewer.scrollTop = vsbStartScroll + ((e.clientY - vsbStartY) / maxTop) * overflow;
}

function endVThumbDrag() {
    vsbDragging = false;
    vScrollbar.classList.remove('dragging');
    document.removeEventListener('mousemove', onVThumbDrag);
    document.removeEventListener('mouseup', endVThumbDrag);
}

vThumb.addEventListener('mousedown', (e) => {
    e.preventDefault();                        // 防拖动时选中图片/起漂
    vsbDragging = true;
    vScrollbar.classList.add('dragging');
    vsbStartY = e.clientY;
    vsbStartScroll = viewer.scrollTop;
    document.addEventListener('mousemove', onVThumbDrag);
    document.addEventListener('mouseup', endVThumbDrag);
});

// ===== 缩放功能 =====
const WIDTH_RATIO_DEFAULT = 3 / 7; // 默认：app 宽度的 3/7
const WIDTH_RATIO_MIN = 1 / 7;     // 最小：app 宽度的 1/7
const ZOOM_STEP = 1.05;             // 点按 / 鼠标点击的缩放倍率
const ZOOM_STEP_HOLD = 1.015;       // 键盘长按连续缩放的倍率（比点按更细，避免快速冲过头）
const ZOOM_MAX_MULT = 2;          // 放大上限：最多到 main 盒子宽的 1.5 倍（超宽部分靠横向平移查看）

let widthRatio = WIDTH_RATIO_DEFAULT;
let panX = 0;                       // 当前横向位移(px)：与 widthRatio 一样仅会话内、不持久化

// 最大：图片可放大到 viewer 宽的 ZOOM_MAX_MULT 倍（clientWidth 不含滚动条）
function maxWidthRatio() {
    return viewer.clientWidth / window.innerWidth * ZOOM_MAX_MULT;
}

function applyImageWidth() {
    document.documentElement.style.setProperty('--image-width', `${widthRatio * 100}vw`);
}

// ---- 横向平移：图片放大到超出 viewer 宽时，用 --pan-x 平移 #image-strip 看被裁到两侧的像素 ----
function imageWidthPx() { return widthRatio * window.innerWidth; }                     // 单图当前像素宽
function maxPanX() { return Math.max(0, (imageWidthPx() - viewer.clientWidth) / 2); }   // 可平移半幅（居中左右各半）
function applyPan() {
    document.documentElement.style.setProperty('--pan-x', `${panX}px`);
}
function clampPan() {                            // 越界夹取并写回 CSS 变量（缩回 ≤ 盒子宽时自动归 0）
    const m = maxPanX();
    panX = Math.min(Math.max(panX, -m), m);
    applyPan();
}

// 记录锁定的内容点落在哪张图片的什么相对位置（0=图顶，1=图底）。
// my0：锚线相对视口顶部的偏移(px)。缺省 0 = 锁定在视口顶行（键盘 / 缩放按钮）；
// 鼠标拖拽缩放传入按下点的偏移，使光标底下那个内容点缩放后仍停在原地（消除纵向漂移）。
function captureAnchor(my0 = 0) {
    const viewerTop = viewer.getBoundingClientRect().top;
    const line = viewerTop + my0;
    for (const img of viewer.querySelectorAll('#image-strip img')) {
        const rect = img.getBoundingClientRect();
        if (rect.height > 0 && rect.bottom > line) {
            return { img, ratio: (line - rect.top) / rect.height, my0 };
        }
    }
    return null;
}

// 缩放后把锁定的内容点移回原来的屏幕位置（视口顶 + my0）。读 getBoundingClientRect 会强制同步重排，
// 随后立即修正 scrollTop，全部在同一帧内完成，肉眼看不到跳动
function restoreAnchor(anchor) {
    if (!anchor || !anchor.img.isConnected) return;
    const viewerTop = viewer.getBoundingClientRect().top;
    const rect = anchor.img.getBoundingClientRect();
    const line = viewerTop + (anchor.my0 || 0);
    viewer.scrollTop += (rect.top + anchor.ratio * rect.height) - line;
}

// anchorMy0：纵向锚线相对视口顶的偏移，透传给 captureAnchor/restoreAnchor；缺省 0 即顶行锚定
function setWidthRatio(next, anchorMy0 = 0) {
    const anchor = captureAnchor(anchorMy0);
    widthRatio = next;
    applyImageWidth();
    restoreAnchor(anchor);
    clampPan();               // 宽度变了→可平移范围变了→重新夹取（缩回 ≤ 盒子宽时归 0）
    autoScrollPos = viewer.scrollTop; // 缩放/侧栏联动改变滚动位置后，同步播放的内部位置
    syncScrollUi();           // 图片高度变化致各图顶部位置改变，重算页码/悬浮条
}

// 非拖拽缩放（键盘 / 工具栏 +/- 按钮）统一以 main 盒子中心为不动点：
// 盒子中心处的图像内容点缩放前后保持不动——横向随图宽等比移动 panX，纵向锚在盒子垂直中线。
function setWidthRatioCentered(next) {
    const V = viewer.clientWidth;
    const my0 = viewer.clientHeight / 2;   // 盒子垂直中线相对 viewer 顶缘
    const W0 = imageWidthPx();
    const fx = (V / 2 - ((V - W0) / 2 + panX)) / W0;   // 盒子水平中心当前对应的图像内容比例
    setWidthRatio(next, my0);
    const W = imageWidthPx();
    panX = V / 2 - (V - W) / 2 - fx * W;               // 让该比例点回到盒子水平中心
    clampPan();
}

function zoom(direction, isHold = false) {
    // 长按连发（isHold=true）用更小步长细调；点按 / 鼠标点击用满步长
    const step = isHold ? ZOOM_STEP_HOLD : ZOOM_STEP;
    const next = direction > 0 ? widthRatio * step : widthRatio / step;
    // 键盘 / 按钮缩放没有鼠标位置可依，统一以盒子中心为不动点
    setWidthRatioCentered(Math.min(Math.max(next, WIDTH_RATIO_MIN), maxWidthRatio()));
}

// 鼠标长按连续缩放（无系统自动重复，用定时器模拟键盘手感）：
// 按下即刻先走一个满步（等价一次单击）；停顿 MOUSE_HOLD_DELAY 后
// 以 ZOOM_STEP_HOLD 小步连发；松开、移出按钮或窗口失焦即停。
const MOUSE_HOLD_DELAY = 500;    // 起步延迟(ms)：按下到开始连发之间，对齐键盘 e.repeat 的起步停顿
const MOUSE_HOLD_INTERVAL = 50;  // 连发间隔(ms)：起步后每 50ms 走一小步

function bindZoomHold(btn, direction) {
    let delayTimer = null;   // 起步延迟计时器
    let repeatTimer = null;  // 连发定时器
    const stop = () => {
        clearTimeout(delayTimer);
        clearInterval(repeatTimer);
        delayTimer = repeatTimer = null;
    };
    btn.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;  // 仅左键
        e.preventDefault();          // 防选中/防系统默认拖选
        zoom(direction);             // 按下即刻走满步，与单击一致
        delayTimer = setTimeout(() => {
            repeatTimer = setInterval(() => zoom(direction, true), MOUSE_HOLD_INTERVAL);
        }, MOUSE_HOLD_DELAY);
    });
    // 松开、移出按钮、窗口失焦都要停：避免“按住后松手在别处”导致停不下来
    btn.addEventListener('mouseup', stop);
    btn.addEventListener('mouseleave', stop);
    window.addEventListener('blur', stop);
}

bindZoomHold(document.getElementById('btn-zoom-in'), 1);
bindZoomHold(document.getElementById('btn-zoom-out'), -1);

// 窗口 resize 或侧栏收放导致 viewer 变窄时，自动收回到不超出 viewer
new ResizeObserver(() => {
    const max = maxWidthRatio();
    if (widthRatio > max) {
        setWidthRatio(max);
    }
    clampPan();   // viewer 变窄会缩小可平移半幅（maxPanX）：即便没触发缩放也要重夹 panX，避免残留越界偏移
    syncScrollUi(); // viewer 尺寸变化致中心水平线移动（窗口缩放 / 侧栏收放），重算页码/悬浮条
}).observe(viewer);

applyImageWidth();
clampPan();   // 初始 maxPanX=0，确保 --pan-x 落定为 0

// ===== 上一张 / 下一张翻页 =====
function getImageElements() {
    return [...viewer.querySelectorAll('#image-strip img')];
}

// 播放中点上一页时的“逃逸”阈值：当前页顶上被盒子顶遮挡的高度 < 自身高度×此比例时，
// 视为你刚翻页落定、只是被播放推出了一小截 → 不再重演本图顶部，而是一键退到上上一页。
// （遮挡恰好从 0 开始增长，取很小的值即可覆盖“刚漂移”场景；想更宽松调大、更保守调小）
const PREV_AUTO_ESCAPE_RATIO = 0.10;

// 视口顶部当前落在第几张图上（容差 1px 避免浮点误差）
function currentImageIndex(imgs) {
    const viewerTop = viewer.getBoundingClientRect().top;
    for (let i = 0; i < imgs.length; i++) {
        if (imgs[i].getBoundingClientRect().bottom > viewerTop + 1) return i;
    }
    return imgs.length - 1;
}

// 让指定图片的顶部对齐 viewer 顶部
function scrollImageToTop(img) {
    const viewerTop = viewer.getBoundingClientRect().top;
    const target = viewer.scrollTop + (img.getBoundingClientRect().top - viewerTop);
    viewer.scrollTo({ top: target, behavior: 'instant' });
}

function goNext() {
    pauseAutoScroll(); // 翻页短暂让位播放，停手后从新图片顶部自动恢复（未播放时为空转）
    const imgs = getImageElements();
    if (!imgs.length) return;
    const i = currentImageIndex(imgs);
    if (i + 1 < imgs.length) scrollImageToTop(imgs[i + 1]);
}

function goPrev() {
    pauseAutoScroll(); // 翻页短暂让位播放，停手后从新图片顶部自动恢复（未播放时为空转）
    const imgs = getImageElements();
    if (!imgs.length) return;
    const i = currentImageIndex(imgs);
    const viewerTop = viewer.getBoundingClientRect().top;
    const rect = imgs[i].getBoundingClientRect();
    // 若正停留在某张图的中部，先回到这张图自己的顶部，再按一次才去上一张
    const midImage = rect.top < viewerTop - 1;
    // 仅播放中：被遮挡不足 10% → 视为刚翻页落定被播放推出的一小截，
    // 直接退到上上一页，打破“吸附回本图顶→播放又推走”的原地打转
    const autoEscape = isAutoScrolling() && midImage
        && (viewerTop - rect.top) < rect.height * PREV_AUTO_ESCAPE_RATIO;
    const target = (midImage && !autoEscape) ? i : i - 1;
    if (target >= 0) scrollImageToTop(imgs[target]);
}

// ---- 长按连发工具：立即触发一次，HOLD_DELAY 后进入 HOLD_INTERVAL 周期触发；返回停止函数 ----
// 键盘 next/prev 与工具栏「上一页 / 下一页」按钮共用。未到 HOLD_DELAY 就松手 = 只触发 1 次，等价原来的单击。
const HOLD_DELAY = 400;      // 长按多少 ms 后进入连发
const HOLD_INTERVAL = 120;   // 连发后每次间隔(ms)，约 8 次/秒
function startHoldRepeat(fn) {
    fn();
    let intervalId = null;
    const delayId = setTimeout(() => { intervalId = setInterval(fn, HOLD_INTERVAL); }, HOLD_DELAY);
    return function stop() {
        clearTimeout(delayId);
        if (intervalId !== null) clearInterval(intervalId);
    };
}

// 「上一页 / 下一页」按钮：mousedown 立即翻一张并起长按连发；收尾挂 document 上的 mouseup
//（而非按钮：按住后把手移出按钮再松开也能可靠停住）。
[['btn-prev', goPrev], ['btn-next', goNext]].forEach(([btnId, fn]) => {
    const btn = document.getElementById(btnId);
    btn.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();                 // 防聚焦按钮 / 选文字，并抑制随后的 click（避免翻两张）
        btn.classList.add('holding');       // 连发按压态视觉反馈（.holding 可选样式）
        const stop = startHoldRepeat(fn);
        const end = () => {
            stop();
            btn.classList.remove('holding');
            document.removeEventListener('mouseup', end);
        };
        document.addEventListener('mouseup', end);
    });
});

// ===== 鼠标点击左/右区域翻页 =====
// 区域划分以“屏幕”为基准（#viewer 可视矩形），不与任何一张图片绑定：滚到哪张图、图占多少高度都无关心。
//   上一张区 = viewer 宽的左侧 35%；下一张区 = viewer 宽的右侧 35%（图片窄于 viewer 时两侧残留区天然并入）
//   中间 30% 按纵向再拆：上方 65% 双击→全屏、下方 35% 单击→进度条（互斥，见下方逻辑）。
//   屏幕上任何位置都可触发：图片间空隙、首张之上 / 末张之下同样响应（单击落在左/右区仍会翻页）。
// 防误触：记录 mousedown 落点，click 时若与落点位移超过阈值 → 视为拖动，不翻页。
//   这也与下方已实现的“抓取拖动滚动”共用同一阈值：拖动必然位移超阈，不会与点击翻页冲突。
const CLICK_NAV_ZONE_RATIO = 0.4;  // 左/右各自触发区占图宽的比例（想调大敏感区就改大）
const CLICK_NAV_MAX_MOVE = 6;       // 按下→松开位移超过此像素当作拖动，不触发翻页
const CLICK_NAV_MIDDLE_TOP_RATIO = 0.7; // 中间区纵向拆分点：上方 65% 归双击全屏，下方 35% 归单击进度条

// ---- 点击翻页配置：左/右区各绑定 上一张/下一张/已禁用，可在快捷键面板下拉里改 ----
// 左、右互不冲突（鼠标同时只能点一处），故允许两边选成同一个动作。
// 生效态 clickCommitted 供实际点击判定；草稿态 clickDraft 供面板编辑，点「保存」才提交。
const CLICK_NAV_KEY = 'imageviewer.clickNav';
const CLICK_NAV_OPTIONS = [
    { value: 'prev', label: '上一张' },
    { value: 'next', label: '下一张' },
    { value: 'disabled', label: '已禁用' },
];
const CLICK_NAV_DEFAULT = { left: 'prev', right: 'next', dbl: 'enabled', mid: 'bar', dragLeft: 'zoom', dragRight: 'pan', rclick: 'sidebar' };

// 双击图片中间（进入/退出全屏）的两态：已启用 / 已禁用
const CLICK_NAV_DBL_OPTIONS = [
    { value: 'enabled', label: '全屏' },
    { value: 'disabled', label: '已禁用' },
];

// 单击图片下方（中间区的下半带）的两态：进度条 / 已禁用
const CLICK_NAV_MID_OPTIONS = [
    { value: 'bar', label: '进度条' },
    { value: 'disabled', label: '已禁用' },
];

// 左键按住拖拽 / 右键按住拖拽的三态：拖动（全向拖拽，横向平移大图 + 竖向滚动页面）/ 缩放 / 已禁用。
// 两行各自独立，允许选成同一个动作（左键、右键按不同按键区分手势，无需互斥）。
const CLICK_NAV_DRAGBTN_OPTIONS = [
    { value: 'pan',      label: '拖动' },
    { value: 'zoom',     label: '缩放' },
    { value: 'disabled', label: '已禁用' },
];

// 鼠标右键的两态：侧栏开关 / 已禁用。不管选哪个都不弹系统右键菜单（固定 preventDefault），
// 「已禁用」仅指不做侧栏动作。
const CLICK_NAV_RCLICK_OPTIONS = [
    { value: 'sidebar', label: '侧栏开关' },
    { value: 'disabled', label: '已禁用' },
];

function loadClickNav() {
    const cfg = { ...CLICK_NAV_DEFAULT };
    try {
        const saved = JSON.parse(localStorage.getItem(CLICK_NAV_KEY) || 'null');
        if (saved && typeof saved === 'object') {
            if (CLICK_NAV_OPTIONS.some((o) => o.value === saved.left)) cfg.left = saved.left;
            if (CLICK_NAV_OPTIONS.some((o) => o.value === saved.right)) cfg.right = saved.right;
            if (CLICK_NAV_DBL_OPTIONS.some((o) => o.value === saved.dbl)) cfg.dbl = saved.dbl;
            if (CLICK_NAV_MID_OPTIONS.some((o) => o.value === saved.mid)) cfg.mid = saved.mid;
            if (CLICK_NAV_DRAGBTN_OPTIONS.some((o) => o.value === saved.dragLeft)) cfg.dragLeft = saved.dragLeft;
            if (CLICK_NAV_DRAGBTN_OPTIONS.some((o) => o.value === saved.dragRight)) cfg.dragRight = saved.dragRight;
            if (CLICK_NAV_RCLICK_OPTIONS.some((o) => o.value === saved.rclick)) cfg.rclick = saved.rclick;
        }
    } catch (e) { /* 解析失败则用默认 */ }
    return cfg;
}

function persistClickNav() {
    try { localStorage.setItem(CLICK_NAV_KEY, JSON.stringify(clickCommitted)); } catch (e) { /* 忽略 */ }
}

let clickCommitted = loadClickNav();      // 生效态
let clickDraft = { ...clickCommitted };   // 草稿态（面板内编辑）

let clickNavDown = null; // 本次按下的视口坐标 {x, y}；仅左键记录

// ---- 长按拖拽（左键 / 右键各一次手势）：按面板「左键长按 / 右键长按」设定 = 拖动 / 缩放 / 已禁用 ----
// 手势类型由“按下的是哪个键”决定，不再依赖拖拽方向，故无需扇区判定 / 起手锁轴：
//   · 拖动(pan)：全向拖拽——水平移动平移大图（panX，仅图宽 > viewer 时有效、clampPan 夹在两边缘内），竖直移动滚动页面（scrollTop），抓图跟手；
//   · 缩放(zoom)：以实时 widthRatio 为基准、每像素 0.2% 平滑跟手，上拖放大、下拖缩小（复用 setWidthRatio 顶部锚定，画面不跳）；
//   · 已禁用(disabled)：长按拖动不做缩放 / 平移（但仍标记发生过拖拽以抑制误翻页 / 误触右键）。
// 未过 CLICK_NAV_MAX_MOVE 阈值不进入拖拽：普通点击照常走翻页；进入拖拽会置 didDragScroll（吞掉左键翻页），右键则置 didRightDrag（吞掉紧随的 contextmenu 侧栏动作）。
let dragScroll = null;      // 本次拖拽状态 {button, startX, startY, lastX, lastY, active, mode}；null 表示未按下
let didDragScroll = false;  // 本次按下发生过拖拽：左键 click 时吞掉翻页动作
let didRightDrag = false;   // 本次右键发生过拖拽：contextmenu 时吞掉侧栏开关
let zoomAnchor = null;      // 鼠标缩放锚点 {mx0(相对 viewer 左缘的按下 X), fx(图像内容比例 0=图左 1=图右)}：进入缩放手势算一次，缩放中据此钉住 panX

function onDragScrollMove(e) {
    if (!dragScroll) return;
    if (!dragScroll.active) {
        const dx = e.clientX - dragScroll.startX;
        const dy = e.clientY - dragScroll.startY;
        if (Math.hypot(dx, dy) <= CLICK_NAV_MAX_MOVE) return; // 未过阈：可能还是一次点击，先不动
        dragScroll.active = true;
        didDragScroll = true;
        if (dragScroll.button === 2) didRightDrag = true;     // 右键拖拽：吞掉随后的 contextmenu 侧栏动作
        viewer.classList.add('drag-scrolling');
        pauseAutoScroll();                                   // 拖拽短暂让位播放，松手自动续播
        // 进入拖拽这帧把参考点挪到当前光标处，位移从下一帧起算，
        // 避免把激活前累积的 ≤CLICK_NAV_MAX_MOVE 位移一次性补进 lastX/lastY 差里造成起手跳动。
        dragScroll.lastX = e.clientX;
        dragScroll.lastY = e.clientY;
        // 缩放手势：记下“按下那一刻”的光标 X 对应的图像内容比例 fx，作为整段手势的不动点锚（plan/鼠标锚定缩放方案.md）。
        // mx0 取按下点 startX（非当前已移动的光标），相对 viewer 左缘，故不受 viewer 位置漂移影响。
        if (dragScroll.mode === 'zoom') {
            const rect = viewer.getBoundingClientRect();
            const V = viewer.clientWidth;
            const W0 = imageWidthPx();
            const mx0 = dragScroll.startX - rect.left;   // 按下点相对 viewer 左缘：横向不动点
            const my0 = dragScroll.startY - rect.top;    // 按下点相对 viewer 顶缘：纵向不动点偏移
            zoomAnchor = { mx0, my0, fx: (mx0 - ((V - W0) / 2 + panX)) / W0 };
        } else {
            zoomAnchor = null;
        }
        return;
    }
    if (dragScroll.mode === 'disabled') return;               // 已禁用：不做缩放 / 平移（仍抑制误触）
    const stepDx = e.clientX - dragScroll.lastX;
    const stepDy = e.clientY - dragScroll.lastY;
    dragScroll.lastX = e.clientX;
    dragScroll.lastY = e.clientY;
    if (dragScroll.mode === 'pan') {
        // 全向拖拽（抓图跟手）：水平→平移大图(panX，鼠标右移→图右移)，竖直→滚动页面(scrollTop)
        panX += stepDx;                 // clampPan 限制在 [-maxPanX, maxPanX]
        clampPan();
        viewer.scrollTop -= stepDy;     // 鼠标下移→内容下移（往上翻）；抓取语义 scrollTop 随鼠标反向
        autoScrollPos = viewer.scrollTop;   // 同步播放内部位置，避免恢复播放时跳
    } else {
        // 缩放：上拖（dy<0）放大、下拖缩小；每像素 0.2%，连乘平滑跟手
        // 鼠标缩放：把纵向锚线改到按下点（zoomAnchor.my0），光标底下的内容点不再上下漂；
        // 非鼠标缩放（键盘 / 按钮）my0 缺省 0，维持原来的顶行锚定
        setWidthRatio(Math.min(Math.max(widthRatio * (1 - stepDy * 0.002), WIDTH_RATIO_MIN), maxWidthRatio()), zoomAnchor ? zoomAnchor.my0 : 0);
        // 锚定缩放：图宽变化后反解 panX，让按下点内容比例 fx 仍落在按下时的屏幕位置 mx0
        // （图宽 ≤ 盒子时 maxPanX=0、clampPan 归 0，与“绕中心”等价，行为不变）
        if (zoomAnchor) {
            const V = viewer.clientWidth;
            const W = imageWidthPx();
            panX = zoomAnchor.mx0 - (V - W) / 2 - zoomAnchor.fx * W;
            clampPan();
        }
    }
}

function endDragScroll() {
    if (dragScroll && dragScroll.active) viewer.classList.remove('drag-scrolling');
    dragScroll = null;
    zoomAnchor = null;   // 收手势清锚点，避免下次非缩放手势误用上次的 fx
    document.removeEventListener('mousemove', onDragScrollMove);
    document.removeEventListener('mouseup', endDragScroll);
}

function beginDragScroll(e, mode) {
    if (!viewer.classList.contains('has-images')) return; // 无图可拖：不进入拖拽
    dragScroll = {
        button: e.button,
        startX: e.clientX, startY: e.clientY,
        lastX: e.clientX, lastY: e.clientY,
        active: false, mode,     // mode: 'pan' | 'zoom' | 'disabled'（由按键对应的面板设定决定）
    };
    didDragScroll = false;
    zoomAnchor = null;           // 每次按下先清锚点，进入拖拽且为缩放时再计算
    document.addEventListener('mousemove', onDragScrollMove);
    document.addEventListener('mouseup', endDragScroll);
}

viewer.addEventListener('mousedown', (e) => {
    // 左键：记录按下点供 click 判定翻页，并按「左键长按」设定挂上拖拽手势
    if (e.button === 0) {
        clickNavDown = { x: e.clientX, y: e.clientY };
        // 正在输入页码时，这次按下即“点其它区域退出编辑”：失焦会提交跳转，标记吞掉紧随的 click 区域动作
        swallowPageJumpClick = pageJumpEditing;
        beginDragScroll(e, clickCommitted.dragLeft); // 不能在这里 preventDefault，否则会阻止输入框失焦提交
    } else if (e.button === 2) {
        didRightDrag = false;   // 每次右键按下先复位，供 contextmenu 判定“刚才是拖拽还是纯点击”
        beginDragScroll(e, clickCommitted.dragRight); // 右键长按拖拽手势（拖动 / 缩放 / 已禁用）
    }
});
viewer.addEventListener('click', (e) => {
    if (e.button !== 0) return;                      // 仅响应鼠标左键
    // 设置小面板弹出时：这一击仅用于收起面板（document 全局监听会自动关闭），
    // 不触发图片区左/中/右三个快捷点击动作（翻页 / 进度条）；同时清干净拖动遗留态。
    if (settingsPanel.classList.contains('open')) { didDragScroll = false; clickNavDown = null; return; }
    // 退出页码输入的那一下点击：跳转已由失焦完成，这里吞掉，避免又触发一次翻页 / 收起
    if (swallowPageJumpClick) { swallowPageJumpClick = false; return; }
    // 本次发生过抓取拖动：即使命回原点附近也吞掉，避免被当成点击而误翻页
    if (didDragScroll) { didDragScroll = false; clickNavDown = null; return; } // 本次发生过拖拽：吞掉点击
    if (clickNavDown) {
        const dx = e.clientX - clickNavDown.x;
        const dy = e.clientY - clickNavDown.y;
        clickNavDown = null;
        if (Math.hypot(dx, dy) > CLICK_NAV_MAX_MOVE) return; // 位移过大→拖动，不翻页
    }
    // 区域以屏幕（viewer 可视矩形）为基准划分，不与具体图片绑定：滚到哪张图都能触发
    const x = e.clientX, y = e.clientY;
    const r = viewer.getBoundingClientRect();
    // 命中左/右区 → 按配置分派动作；「禁用」或中间区都无翻页动作
    const action = (x <= r.left + r.width * CLICK_NAV_ZONE_RATIO) ? clickCommitted.left
                 : (x >= r.right - r.width * CLICK_NAV_ZONE_RATIO) ? clickCommitted.right
                 : null;
    if (action === 'prev') goPrev();
    else if (action === 'next') goNext();
    // 中间区（左右之外）：已弹出→单击顶部或底部都收起（顶部=全屏区，需求④）；
    //   未弹出→仅单击底部 35% 才弹出，顶部留给双击全屏
    else if (pageJump.classList.contains('show')) closePageJump();
    else if (y >= r.top + r.height * CLICK_NAV_MIDDLE_TOP_RATIO && clickCommitted.mid === 'bar'
             && viewer.classList.contains('has-images')) openPageJump(); // 空态（无图片）不弹进度条
});

// ===== 鼠标双击图片中间上方区：进入/退出全屏 =====
// 区域同样以屏幕（viewer 可视矩形）为基准：中间 30% 宽的上方 65%；仅当面板「鼠标双击图片中间」= 全屏时生效。
viewer.addEventListener('dblclick', (e) => {
    if (e.button !== 0) return;                        // 仅响应鼠标左键
    if (clickCommitted.dbl !== 'enabled') return;      // 已禁用：双击无动作
    if (!viewer.classList.contains('has-images')) return; // 空态（无图片）：不触发全屏
    const r = viewer.getBoundingClientRect();
    const x = e.clientX, y = e.clientY;
    const inLeft = x <= r.left + r.width * CLICK_NAV_ZONE_RATIO;
    const inRight = x >= r.right - r.width * CLICK_NAV_ZONE_RATIO;
    if (inLeft || inRight) return;                     // 只认中间区，左右区留给单击翻页
    if (y >= r.top + r.height * CLICK_NAV_MIDDLE_TOP_RATIO) return; // 落在下方 35%（进度条区）：双击无动作
    toggleFullscreen();                                // 上方 65%：双击进入/退出全屏
});

// ===== 鼠标右键：开关侧栏（可在面板改为“已禁用”）=====
// 不论设定为何，都固定拦截浏览器 / WebView 的默认右键小菜单；「已禁用」只是不做侧栏动作。
// 绑在 #app（同时涵盖 #viewer 与 #sidebar）：两侧区域右键都能开关侧栏，不再只在图片区生效。
// 与左键交互无冲突：mousedown / click / dblclick 都仅响应 e.button === 0，右键不会误触翻页与拖动。
app.addEventListener('contextmenu', (e) => {
    e.preventDefault();   // 不弹默认菜单（与设定无关，始终屏蔽）
    // 快捷键面板（模态）打开时：仅屏蔽菜单，不改侧栏，避免正在改键 / 改鼠标设定时误触
    if (shortcutOverlay.classList.contains('open')) return;
    // 刚完成一次右键拖拽：这次 contextmenu 是拖拽副产物，吞掉侧栏开关（didRightDrag 留待下次右键按下复位）
    if (didRightDrag) return;
    if (clickCommitted.rclick === 'sidebar') toggleSidebar();   // 已禁用：右键无动作
});

// ===== 进度条弹窗：单击图片中间下方区弹出，接线跳页 / 拖动 / 手动输入 =====
// 触发区（中间下方 35%）与全屏区（中间上方 65%）纵向互斥，单击 / 双击各落各区，无时间歧义。
// 接线要点：
//   ① 点数字按钮进入输入态，失焦（点其它区域）才跳转，不即时跳；
//   ② 只点左右箭头翻范围不跳转，拖动滑块才跳；
//   ③ 弹出期间随主视图滚动实时跟随（页码 / 区间 / 滑块都对齐现实）；
//   ④ 收起方式：再单击底部区、单击顶部全屏区、打开设置按钮。
const pageJump = document.getElementById('page-jump');
const pageJumpCurrent = document.getElementById('page-jump-current');
const pageJumpInput = document.getElementById('page-jump-input');
const pageJumpMin = pageJump.querySelector('.page-jump-min');
const pageJumpMax = pageJump.querySelector('.page-jump-max');
const pageJumpTrack = pageJump.querySelector('.page-jump-track');
const pageJumpThumb = pageJump.querySelector('.page-jump-thumb');
const pageJumpTotal = document.getElementById('page-jump-total');
const pageJumpTicks = pageJump.querySelector('.page-jump-ticks');
const pageJumpArrowLeft = document.getElementById('page-jump-arrow-left');
const pageJumpArrowRight = document.getElementById('page-jump-arrow-right');
const PAGE_JUMP_WINDOW_SIZE = 30;   // 进度条一屏最多容纳的页数
let pageJumpWindow = 0;             // 当前显示的页区间序号（0 起）
let pageJumpEditing = false;        // 数字按钮处于输入态
let pageJumpDragging = false;       // 正在拖动滑块
let swallowPageJumpClick = false;   // 退出输入的那一下 viewer 点击：吞掉其区域动作

// 让进度条水平中心始终对齐「预览区(#viewer) 中心」：图片放大到超出盒子宽并左右平移时，
// 图片的真实显示中心会随 --pan-x 漂移（甚至漂进侧栏），若进度条跟随它就会乱跑；
// 进度条本应固定在预览区中央，故这里以 viewer 矩形中心定位（图宽 ≤ 盒子时二者重合，行为与旧版一致）。
function centerPageJumpOnImage() {
    const r = viewer.getBoundingClientRect();
    pageJump.style.left = (r.left + r.width / 2) + 'px';
}

// 读当前总页数与页码（1 起）；空目录时按 1 页占位。
function currentPageJumpInfo() {
    const imgs = getImageElements();
    const total = imgs.length || 1;
    const cur = imgs.length ? currentImageIndex(imgs) + 1 : 1;
    return { total, cur };
}

// 由 pageJumpWindow 求本区间的起止页 / 页数 / 区间上限（并夹在合法范围内）
function pageJumpWindowBounds(total) {
    const size = PAGE_JUMP_WINDOW_SIZE;
    const maxWindow = Math.max(0, Math.ceil(total / size) - 1);
    const w = Math.min(Math.max(pageJumpWindow, 0), maxWindow);
    const start = w * size + 1;
    const end = Math.min(start + size - 1, total);
    return { w, start, end, count: end - start + 1, maxWindow };
}

// 进度条跳转令牌：预加载 await 期间若又发起新跳转（拖动轨道连续跳），只认最新那次，
// 避免旧的过期跳转在新跳转之后才加载完、把画面又滚回旧目标。
let pageJumpSeq = 0;

// 跳到指定页（1 起）：越界自动夹到 [1, 总数]（<1→首页，>共→末页），复用翻页同款定位。
// 与侧栏跳转同理：目标图若尚未下载（懒加载、从没进过视口）则先预加载再滚，否则滚过去会空一帧闪烁；
// 已缓存的近跳不额外等待，保持即时。
async function jumpToPage(page) {
    const imgs = getImageElements();
    if (!imgs.length) return;
    const idx = Math.min(Math.max(Math.round(page), 1), imgs.length) - 1;
    const target = imgs[idx];
    pauseAutoScroll();                 // 跳转短暂让位播放，停手后从新图顶部自动续播
    const seq = ++pageJumpSeq;
    if (!(target.complete && target.naturalWidth > 0)) {
        target.loading = 'eager';      // 取消懒加载：配合下面预加载好的字节，滚入即出
        await preloadImage(target.src);
        if (seq !== pageJumpSeq) return;   // 期间已发起更新的跳转：丢弃这次过期滚动
        if (!target.isConnected) return;
    }
    scrollImageToTop(target);
    syncScrollUi();
}

// 按当前区间渲染：两端数字=本区间首/末页，刻度数=本区间页数，
// 滑块=当前页在本区间内的比例位置，箭头=到首/末区间时置灰禁用。
function renderPageJump() {
    const { total, cur } = currentPageJumpInfo();
    const b = pageJumpWindowBounds(total);
    pageJumpWindow = b.w;

    pageJumpTotal.textContent = total;
    pageJumpCurrent.textContent = cur;
    pageJumpMin.textContent = b.start;
    pageJumpMax.textContent = b.end;
    pageJumpTicks.style.setProperty('--tick-intervals', Math.max(1, b.count - 1));

    // 滑块位置：当前页落在本区间内按比例放；落在区间外则贴最近一端
    let pos;
    if (cur < b.start) pos = 0;
    else if (cur > b.end) pos = 100;
    else pos = b.count > 1 ? ((cur - b.start) / (b.count - 1)) * 100 : 0;
    pageJumpThumb.style.left = pos + '%';

    // 箭头禁用态：第一区间禁左、最后区间禁右
    pageJumpArrowLeft.disabled = b.w <= 0;
    pageJumpArrowRight.disabled = b.w >= b.maxWindow;
}

// 弹出期间随主视图滚动跟随：区间自动切到当前页所在段，页码 / 滑块 / 位置一并对齐现实
function refreshPageJumpFollow() {
    const { cur } = currentPageJumpInfo();
    pageJumpWindow = Math.floor((cur - 1) / PAGE_JUMP_WINDOW_SIZE);
    renderPageJump();
    centerPageJumpOnImage();
}

function openPageJump() {
    exitPageJumpEdit(false);
    refreshPageJumpFollow();   // 打开即定位到当前页所在区间
    pageJump.classList.add('show');
}

function closePageJump() {
    exitPageJumpEdit(false);
    pageJump.classList.remove('show');
}

// ---- 数字按钮：点击进入输入态，失焦 / 回车才跳转（点其它区域即退出编辑并跳）----
function enterPageJumpEdit() {
    if (pageJumpEditing) return;
    pageJumpEditing = true;
    pageJumpInput.value = String(pageJumpCurrent.textContent);
    pageJumpCurrent.style.display = 'none';
    pageJumpInput.style.display = 'inline-block';
    pageJumpInput.focus();
    pageJumpInput.select();
}

function exitPageJumpEdit(commit) {
    if (!pageJumpEditing) return;
    const txt = pageJumpInput.value.trim();
    pageJumpEditing = false;
    pageJumpInput.style.display = 'none';
    pageJumpCurrent.style.display = '';
    if (commit) {
        const n = parseInt(txt, 10);
        if (!Number.isNaN(n)) jumpToPage(n);   // 越界夹取；非法输入不跳
    }
}

pageJumpCurrent.addEventListener('click', (e) => {
    e.stopPropagation();
    enterPageJumpEdit();
});
pageJumpInput.addEventListener('blur', () => exitPageJumpEdit(true));  // 点其它区域失焦 → 退出编辑并跳转
pageJumpInput.addEventListener('keydown', (e) => {
    e.stopPropagation();                       // 输入数字/回车/空格不要被全局快捷键抢走
    if (e.key === 'Enter') { e.preventDefault(); exitPageJumpEdit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); exitPageJumpEdit(false); } // Esc 取消本次输入，不跳
});

// ---- 拖动滑块：按刻度逐页吸附（一跳一跳），拖动时图片实时跟随跳转；点轨道任意处也直接跳到对应页 ----
let dragTrackRect = null, dragStart = 1, dragCount = 1, dragPage = 1;

// 由轨道内某横向位置求对应页（落在 [start,end] 内，吸附到整页）
function pageAtTrackX(clientX, rect, start, count) {
    let p = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    p = Math.min(Math.max(p, 0), 1);
    return start + Math.round(p * (count - 1));
}

// 把滑块回写到某页对应的刻度位置（拖动时不走平滑过渡，随刻度一跳一跳）
function snapThumbToPage(page) {
    const pct = dragCount > 1 ? ((page - dragStart) / (dragCount - 1)) * 100 : 0;
    pageJumpThumb.style.transition = 'none';     // 关掉可能的平滑动画，保证是“跳”而不是“滑”
    pageJumpThumb.style.left = pct + '%';
}

function onThumbDragMove(e) {
    if (!pageJumpDragging) return;
    const page = pageAtTrackX(e.clientX, dragTrackRect, dragStart, dragCount); // 吸附到整页
    if (page === dragPage) return;                 // 仍在同一刻度内：不动、不重复跳
    dragPage = page;
    snapThumbToPage(page);
    pageJumpCurrent.textContent = page;          // 拖动时“第 xx 页”随目标页实时更新（拖拽期间跳过了自动跟随刷新，这里手动同步）
    jumpToPage(page);                             // 拖动即时跳转图片（高速跳转会有轻微闪烁，符合预期）
}

function endThumbDrag() {
    if (!pageJumpDragging) return;
    pageJumpDragging = false;
    document.removeEventListener('mousemove', onThumbDragMove);
    document.removeEventListener('mouseup', endThumbDrag);
}

// 按下轨道任意处即进入拖动（与原生 <input type=range> 行为一致：支持点击、拖动、点击后不松手继续拖）：
//   · 按滑块本身：以其当前刻度为起点，不产生初始跳转，直接跟手；
//   · 按轨道空白 / 刻度：落点先即时吸附跳转，随后不松手继续拖也照样跟手。
pageJumpTrack.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();                        // 防选中文字 / 起漂
    const b = pageJumpWindowBounds(currentPageJumpInfo().total);
    dragTrackRect = pageJumpTrack.getBoundingClientRect();
    dragStart = b.start;
    dragCount = b.count;
    if (pageJumpThumb.contains(e.target)) {
        // 按在滑块上：反推其当前页为起点，未真正拖动就松手等价无变化
        const pct = parseFloat(pageJumpThumb.style.left) || 0;
        dragPage = dragStart + Math.round((pct / 100) * (dragCount - 1));
    } else {
        // 按在轨道空白 / 刻度：落点即时跳转，再进入拖动
        dragPage = pageAtTrackX(e.clientX, dragTrackRect, dragStart, dragCount);
        snapThumbToPage(dragPage);
        pageJumpCurrent.textContent = dragPage;
        jumpToPage(dragPage);
    }
    pageJumpDragging = true;
    document.addEventListener('mousemove', onThumbDragMove);
    document.addEventListener('mouseup', endThumbDrag);
});

// ---- 左右箭头：仅翻动进度条显示的页区间，不触发跳转（需求②）----
pageJumpArrowLeft.addEventListener('click', (e) => {
    e.stopPropagation();
    if (pageJumpWindow > 0) { pageJumpWindow--; renderPageJump(); }
});
pageJumpArrowRight.addEventListener('click', (e) => {
    e.stopPropagation();
    const { maxWindow } = pageJumpWindowBounds(currentPageJumpInfo().total);
    if (pageJumpWindow < maxWindow) { pageJumpWindow++; renderPageJump(); }
});

// ===== 自动滚动（播放） =====
let autoScrollSpeed = 40; // 滚动速度：像素/秒（设置面板可调，localStorage 持久化）

const playBtn = document.getElementById('btn-play');
let autoScrollId = null;
let lastTimestamp = 0;
// 浮点滚动位置：浏览器 scrollTop 会取整，低速播放时小数增量会丢失，
// 因此用 JS 变量累积真实位置，每帧整体赋值
let autoScrollPos = 0;
// 手动操作暂停机制：滚轮/↑↓/翻页触发后暂停播放一小段（见 MANUAL_SCROLL_PAUSE_MS），期间无新输入则自动恢复；
// 连续操作会不断重置计时，不会操作到一半突然恢复
let pausedByManualScroll = false;
let manualScrollTimer = null;
const MANUAL_SCROLL_PAUSE_MS = 300;

function isAutoScrolling() {
    return autoScrollId !== null;
}

function autoScrollStep(timestamp) {
    if (pausedByManualScroll) return; // 暂停期间不做任何事，等待恢复
    if (!lastTimestamp) lastTimestamp = timestamp;
    const dt = (timestamp - lastTimestamp) / 1000; // 距上一帧的秒数
    lastTimestamp = timestamp;

    autoScrollPos += autoScrollSpeed * dt;
    viewer.scrollTop = autoScrollPos;

    // 到达底部时停止
    if (viewer.scrollTop + viewer.clientHeight >= viewer.scrollHeight - 1) {
        stopAutoScroll();
        return;
    }
    autoScrollId = requestAnimationFrame(autoScrollStep);
}

function startAutoScroll() {
    if (isAutoScrolling()) return;
    autoScrollPos = viewer.scrollTop; // 从当前位置开始
    lastTimestamp = 0;
    autoScrollId = requestAnimationFrame(autoScrollStep);
    playBtn.classList.add('playing');
}

function stopAutoScroll() {
    // 显式停止时清掉待恢复计时，避免停止后又被自动恢复
    clearTimeout(manualScrollTimer);
    manualScrollTimer = null;
    pausedByManualScroll = false;
    if (!isAutoScrolling()) return;
    cancelAnimationFrame(autoScrollId);
    autoScrollId = null;
    playBtn.classList.remove('playing');
}

// 手动操作（滚轮/↑↓/翻页）时短暂暂停播放，一小段后自动恢复
function pauseAutoScroll() {
    if (!isAutoScrolling()) return;
    pausedByManualScroll = true;
    clearTimeout(manualScrollTimer);
    manualScrollTimer = setTimeout(() => {
        manualScrollTimer = null;
        if (!isAutoScrolling()) { pausedByManualScroll = false; return; }
        pausedByManualScroll = false;
        // 在恢复时才同步内部位置：此刻手动滚动已稳定，viewer.scrollTop 是真实最终位置。
        // （若在暂停时同步，wheel 事件触发瞬间浏览器尚未应用本次滚动量，autoScrollPos 会慢一拍，导致恢复时跳一下）
        autoScrollPos = viewer.scrollTop;
        lastTimestamp = 0; // 重置帧计时，避免把暂停的 1 秒当成 dt 一次性跳过
        autoScrollId = requestAnimationFrame(autoScrollStep);
    }, MANUAL_SCROLL_PAUSE_MS);
}

function togglePlay() {
    isAutoScrolling() ? stopAutoScroll() : startAutoScroll();
}

playBtn.addEventListener('click', togglePlay);

viewer.addEventListener('wheel', pauseAutoScroll, { passive: true }); // 滚轮固定为内容滚动：原生滚动 + 短暂让位播放

// ===== 设置面板（间距/速度实时生效，localStorage 持久化） =====
const settingsBtn = document.getElementById('btn-settings');
const settingsPanel = document.getElementById('settings-panel');

settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    settingsPanel.classList.toggle('open');
    closePageJump();   // 需求④.3：点设置按钮时收起进度条弹窗
});

// 点击面板外部时关闭
document.addEventListener('click', (e) => {
    if (!settingsPanel.contains(e.target)) {
        settingsPanel.classList.remove('open');
    }
});

// ===== 眼睛按钮：隐藏/显示工具栏其余按钮（可选连同页码与侧栏收起按钮一起隐藏）=====
const toolbar = document.getElementById('toolbar');
const hideExtraToggle = document.getElementById('hide-extra-toggle');

// 由“沉浸隐藏态(ui-hidden)”与“开关”共同决定 #app 的 hide-extra-ui 类，并即时刷新页码显隐
function applyHideExtraUi() {
    const on = hideExtraToggle.checked && toolbar.classList.contains('ui-hidden');
    app.classList.toggle('hide-extra-ui', on);
    updatePageIndicator();
}

// 恢复持久化的开关状态（默认关闭）
if (loadSetting('imageviewer.hideExtraUI', 0) === 1) hideExtraToggle.checked = true;

hideExtraToggle.addEventListener('change', () => {
    saveSetting('imageviewer.hideExtraUI', hideExtraToggle.checked ? 1 : 0);
    applyHideExtraUi();
});

// 抽成具名函数，供按钮点击与快捷键（默认 /）复用
function toggleUi() {
    const hidden = toolbar.classList.toggle('ui-hidden');
    if (hidden) settingsPanel.classList.remove('open'); // 隐藏时一并收起设置面板
    applyHideExtraUi();
}
document.getElementById('btn-toggle-ui').addEventListener('click', toggleUi);

// ===== 快捷键设置面板（单键改键：每个功能绑定一个按键） =====
// 约定：每个动作绑定"恰好一个按键"。普通键用物理 e.code（输入法无关）；
// 修饰键用 e.key 规范化为不分左右的 Shift/Ctrl/Alt（兼容右 Shift 被输入法合成、e.code 为空的情况）。
// 面板内为草稿态，只有点"保存"才提交为生效态并持久化到 localStorage。
const DEFAULT_SHORTCUTS = [
    { id: 'zoom-in',     action: '放大',     code: 'Comma' },
    { id: 'zoom-out',    action: '缩小',     code: 'Period' },
    { id: 'scroll-up',   action: '向上滚动', code: 'ArrowUp' },
    { id: 'scroll-down', action: '向下滚动', code: 'ArrowDown' },
    { id: 'prev',        action: '上一页',   code: 'ArrowLeft' },
    { id: 'next',        action: '下一页',   code: 'ArrowRight' },
    { id: 'fullscreen',  action: '全屏',     code: 'Enter' },
    { id: 'play',        action: '播放',     code: 'Space' },
    { id: 'sidebar',     action: '侧栏',     code: 'Shift' },
    { id: 'toggle-ui',   action: '隐藏', code: 'Slash' },
    { id: 'pan-left',    action: '左移', code: 'Semicolon' },
    { id: 'pan-right',   action: '右移', code: 'Quote' },
];

const SHORTCUT_STORAGE_KEY = 'imageviewer.shortcuts';

// 物理 e.code -> 面板显示文本
const CODE_LABELS = {
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Enter: 'Enter', Space: 'Space', Tab: 'Tab', Escape: 'Esc',
    Comma: ',', Period: '.', Slash: '/', Minus: '-', Equal: '=',
    Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
    Backspace: 'Backspace', Delete: 'Del', Insert: 'Ins',
    Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn',
    Shift: 'Shift', Ctrl: 'Ctrl', Alt: 'Alt', Meta: 'Win',
    ControlLeft: '左 Ctrl', ControlRight: '右 Ctrl',
    AltLeft: '左 Alt', AltRight: '右 Alt',
    ShiftLeft: '左 Shift', ShiftRight: '右 Shift',
};

function codeToLabel(code) {
    if (CODE_LABELS[code]) return CODE_LABELS[code];
    let m;
    if ((m = code.match(/^Key([A-Z])$/))) return m[1];
    if ((m = code.match(/^Digit(\d)$/))) return m[1];
    if ((m = code.match(/^Numpad(\d)$/))) return 'Num' + m[1];
    if (/^F([1-9]|1[0-2])$/.test(code)) return code;
    return code;
}

// 修饰键：用 e.key 规范化为不分左右的令牌（左右 Shift/Ctrl/Alt 归一），
// 这样即使输入法把右 Shift 合成为 e.code 为空的事件，也能正确识别与显示。
const MODIFIER_KEY_NAMES = { Shift: 'Shift', Control: 'Ctrl', Alt: 'Alt', Meta: 'Meta', OS: 'Meta' };

// 由键盘事件求"按键令牌"：修饰键取规范名，普通键取物理 e.code（为空时兜底 e.key）
function keyToken(e) {
    if (MODIFIER_KEY_NAMES[e.key]) return MODIFIER_KEY_NAMES[e.key];
    return e.code || e.key || '';
}

// 兼容旧存档：把已废弃的"分左右物理码"迁移到规范单键令牌
function migrateCode(c) {
    if (c === 'ShiftLeft' || c === 'ShiftRight') return 'Shift';
    if (c === 'ControlLeft' || c === 'ControlRight') return 'Ctrl';
    if (c === 'AltLeft' || c === 'AltRight') return 'Alt';
    return c;
}

// 生效态（实际触发用）与草稿态（面板内编辑，仅"保存"后生效）
let committed = {};        // id -> code
let draft = {};            // id -> code
let codeToId = new Map();  // committed 反查：code -> id

function rebuildLookup() {
    codeToId = new Map();
    for (const [id, code] of Object.entries(committed)) codeToId.set(code, id);
}

function loadCommitted() {
    const map = {};
    DEFAULT_SHORTCUTS.forEach((s) => { map[s.id] = s.code; });
    try {
        const saved = JSON.parse(localStorage.getItem(SHORTCUT_STORAGE_KEY) || 'null');
        if (saved && typeof saved === 'object') {
            for (const s of DEFAULT_SHORTCUTS) {
                const v = saved[s.id];
                // 仅接受单键令牌；忽略历史遗留的组合令牌（含 '+'），并把旧的左右物理码迁移到规范名
                if (typeof v === 'string' && v && v.indexOf('+') === -1) map[s.id] = migrateCode(v);
            }
        }
    } catch (e) { /* 解析失败则用默认 */ }
    return map;
}

function persistCommitted() {
    try { localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(committed)); } catch (e) { /* 忽略 */ }
}

// 键盘平移步长：按一次左/右移把图推移的像素数（超盒子宽才有意义）。
// 点按（首次按下，isHold=false）走满步 KEY_PAN_STEP；长按连发（e.repeat，isHold=true）走小步 KEY_PAN_STEP_HOLD，避免越拖越快。
const KEY_PAN_STEP = 40;
const KEY_PAN_STEP_HOLD = 15;

// 动作分派：命中哪个动作就执行对应行为（统一用箭头包裹，避免定义顺序/TDZ 问题）
const ACTION_HANDLERS = {
    'zoom-in': (isHold) => zoom(1, isHold),
    'zoom-out': (isHold) => zoom(-1, isHold),
    'scroll-up': () => { pauseAutoScroll(); viewer.scrollTop -= KEY_SCROLL_STEP; },
    'scroll-down': () => { pauseAutoScroll(); viewer.scrollTop += KEY_SCROLL_STEP; },
    'prev': () => goPrev(),
    'next': () => goNext(),
    'fullscreen': () => toggleFullscreen(),
    'play': () => togglePlay(),
    'sidebar': () => toggleSidebar(),
    'toggle-ui': () => toggleUi(),
    'pan-left':  (isHold) => { panX += isHold ? KEY_PAN_STEP_HOLD : KEY_PAN_STEP; clampPan(); },   // 左移=看图片更左侧 → 图实际右移(panX 增)
    'pan-right': (isHold) => { panX -= isHold ? KEY_PAN_STEP_HOLD : KEY_PAN_STEP; clampPan(); },   // 右移反之 → 图实际左移(panX 减)
};
// 允许长按连续触发的动作；其余动作长按只触发一次，避免 toggle 抖动
// zoom-in/out 与 pan-left/right 长按连发：首次走满步、之后走小步（靠分派处传 e.repeat 区分 isHold）
const REPEATABLE_ACTIONS = new Set(['scroll-up', 'scroll-down', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right']);

// 面板元素与编辑态
const shortcutOverlay = document.getElementById('shortcut-overlay');
const shortcutPanel = document.getElementById('shortcut-panel');
const shortcutList = document.getElementById('shortcut-list');
const mouseList = document.getElementById('mouse-list');   // 右栏：鼠标点击设置的两个下拉
const keyBoxById = {};        // id -> 键位盒子元素
let editingId = null;         // 当前处于修改模式的槽 id

function renderShortcuts() {
    shortcutList.innerHTML = '';
    for (const def of DEFAULT_SHORTCUTS) {
        const li = document.createElement('li');
        li.className = 'shortcut-row';

        const action = document.createElement('span');
        action.className = 'shortcut-action';
        action.textContent = def.action;

        const leader = document.createElement('span');
        leader.className = 'shortcut-leader';

        const key = document.createElement('span');
        key.className = 'shortcut-key';
        key.textContent = codeToLabel(draft[def.id]);
        // 单击键位盒子进入修改模式；stopPropagation 避免触发面板的"点击其它位置退出"
        key.addEventListener('click', (e) => {
            e.stopPropagation();
            enterEditMode(def.id);
        });

        keyBoxById[def.id] = key;
        li.append(action, leader, key);
        shortcutList.appendChild(li);
    }

    renderClickNavRows(); // 渲染右栏「鼠标设置」循环按钮（拖拽 / 左 / 右 / 下方 / 双击 / 右键）
}

// ===== 侧栏缩略图盒子尺寸：7 档预设（快捷键面板「预览图大小」滑块驱动，点「保存」生效）=====
// 想微调各档盒子尺寸，只改下面对象的 w / h（单位 px）；档序按尺寸升序。增删档位无需改滑块，最大档与刻度数由数组长度自动推导。
const THUMB_SIZES = [
    { w: 88,  h: 120 },   // 小
    { w: 117, h: 160 },   // 较小
    { w: 154, h: 210 },   // 中（默认档）
    { w: 183, h: 250 },   // 较大
    { w: 234, h: 320 },   // 大
    { w: 271, h: 370 },   // 特大
    { w: 315, h: 430 },   // 超大
];
const SIZE_LABELS = ['小', '较小', '中', '较大', '大', '特大', '超大'];
const THUMB_STEP_KEY = 'imageviewer.thumbStep';
const THUMB_STEP_DEFAULT = 2;   // 默认「中」

// 写入某档盒子尺寸到 --thumb-w / --thumb-h
function setThumbBoxSize(step) {
    const { w, h } = THUMB_SIZES[step];
    const root = document.documentElement.style;
    root.setProperty('--thumb-w', `${w}px`);
    root.setProperty('--thumb-h', `${h}px`);
}

// 生效档（点「保存」才变更）与面板草稿；启动从持久化恢复并立即应用
// ——此行先于 sidebar.js 执行，故侧栏默认宽度会按恢复后的 --thumb-w 计算
let thumbStepCommitted = Math.min(Math.max(Math.round(loadSetting(THUMB_STEP_KEY, THUMB_STEP_DEFAULT)), 0), THUMB_SIZES.length - 1);
let thumbStepDraft = thumbStepCommitted;
setThumbBoxSize(thumbStepCommitted);

// 提交草稿 → 生效：应用盒子尺寸 + 让侧栏宽度实时重算到“刚好三列” + 持久化
function commitThumbStep() {
    thumbStepCommitted = thumbStepDraft;
    setThumbBoxSize(thumbStepCommitted);
    if (typeof window.refitSidebarWidth === 'function') window.refitSidebarWidth();
    saveSetting(THUMB_STEP_KEY, thumbStepCommitted);
}

// ===== 侧栏默认列数：1~8（快捷键面板「预览图片列数」滑块驱动，点「保存」生效）=====
// 列数只改侧栏“默认宽度”公式里的列数因子（见 sidebar.js 的 refitSidebarWidth），不改盒子尺寸；与尺寸档正交。
const SIDEBAR_COLS_KEY = 'imageviewer.sidebarCols';
const SIDEBAR_COLS_DEFAULT = 3;
const SIDEBAR_COLS_MIN = 1;
const SIDEBAR_COLS_MAX = 8;
function clampCols(n) {
    return Math.min(Math.max(Math.round(Number(n) || SIDEBAR_COLS_DEFAULT), SIDEBAR_COLS_MIN), SIDEBAR_COLS_MAX);
}
// 生效列数（点「保存」才变更）与面板草稿；启动从持久化恢复，并写入全局供 sidebar.js 的 refitSidebarWidth 读取
let colsCommitted = clampCols(loadSetting(SIDEBAR_COLS_KEY, SIDEBAR_COLS_DEFAULT));
let colsDraft = colsCommitted;
window.sidebarColCount = colsCommitted;   // 此行先于 sidebar.js 执行，令侧栏默认宽度按恢复后的列数计算

// 提交草稿 → 生效：更新全局列数 + 让侧栏宽度实时重算到“刚好 N 列” + 持久化
function commitCols() {
    colsCommitted = colsDraft;
    window.sidebarColCount = colsCommitted;
    if (typeof window.refitSidebarWidth === 'function') window.refitSidebarWidth();
    saveSetting(SIDEBAR_COLS_KEY, colsCommitted);
}

// ===== 字体大小档（快捷键面板「调整字体大小」滑块驱动；点「保存」生效，持久化并恢复）=====
// 机制：所有 font-size 写成 calc(基准 + var(--font-offset))，本档只改这一个变量即可整体缩放（见 style.css :root）。
// 「中」= 基准（offset 0，即当前各字号原状）。逐档 +3px 递增：小/中/大/特大/超大 = -3/0/+3/+6/+9。
// 未接线的档位在 FONT_OFFSETS 里置 0（选了等同「中」，不变字号），逐步骤打开并修复崩溃布局。
const FONT_SIZE_LABELS = ['小', '中', '大', '特大', '超大'];
const FONT_SIZE_DEFAULT = 2;      // 默认落在「大」（index 2）
const FONT_OFFSETS = [-3, 0, 3, 6, 9];   // 各档 → --font-offset(px)；小=-3、中=0、大=+3、特大=+6、超大=+9 全部已接线
const TOOL_SCALE = [1, 1, 1, 1.3, 1.5]; // 工具栏按钮缩放倍率（相对原尺寸）：小/中/大=1 原样；特大=1.3、超大=1.5
const SHORTCUT_SCALE = [1, 1, 1.1, 1.1, 1.1]; // 快捷键面板宽度额外倍率（相对本档基础宽）：小/中=1 原样；大/特大/超大=1.1（各 +10%）
const SIDE_SCALE = [1, 1, 1, 1.3, 1.6];     // 侧栏开关 + 回到顶部按钮缩放倍率（相对原尺寸）：小/中/大=1 原样；特大=1.3、超大=1.6
const DIR_TOP_EXTRA = [0, 0, 0, 12, 24];   // 面包屑顶部额外留白(px)：避开变大的侧栏开关按钮；小/中/大=0，特大=+12、超大=+24
const SCROLL_EXTRA = [0, 0, 0, 3, 6];      // 滚动条额外宽度(px)：基准 16px，小/中/大=0 原样；特大=+3→19、超大=+6→22
const PAGE_SCALE = [1, 1, 1, 1.1, 1.2];    // 进度条轨道横向宽度缩放倍率：小/中/大=1 原样（220px）；特大=1.1→242、超大=1.2→264
const PAGE_DOWN = [0, 0, 0, 10, 20];       // 页码指示额外下移(px)：小/中/大=0 原样；特大=+10、超大=+20
const FONT_STEP_KEY = 'imageviewer.fontStep';
function clampFontStep(n) {
    return Math.min(Math.max(Math.round(Number(n) || 0), 0), FONT_SIZE_LABELS.length - 1);
}
function applyFontOffset(index) {
    document.documentElement.style.setProperty('--font-offset', `${FONT_OFFSETS[index] || 0}px`);
    document.documentElement.style.setProperty('--tool-scale', String(TOOL_SCALE[index] ?? 1));
    document.documentElement.style.setProperty('--shortcut-scale', String(SHORTCUT_SCALE[index] ?? 1));
    document.documentElement.style.setProperty('--side-scale', String(SIDE_SCALE[index] ?? 1));
    document.documentElement.style.setProperty('--dir-top-extra', `${DIR_TOP_EXTRA[index] || 0}px`);
    document.documentElement.style.setProperty('--scroll-extra', `${SCROLL_EXTRA[index] || 0}px`);
    document.documentElement.style.setProperty('--page-scale', String(PAGE_SCALE[index] ?? 1));
    document.documentElement.style.setProperty('--page-down', `${PAGE_DOWN[index] || 0}px`);
}
// 生效档（点「保存」才变更）与面板草稿；启动从持久化恢复并立即应用字号偏移
let fontStepCommitted = clampFontStep(loadSetting(FONT_STEP_KEY, FONT_SIZE_DEFAULT));
let fontStepDraft = fontStepCommitted;
applyFontOffset(fontStepCommitted);   // 启动即恢复上次字号档

// 提交草稿 → 生效：应用字号偏移 + 持久化
function commitFontStep() {
    fontStepCommitted = fontStepDraft;
    applyFontOffset(fontStepCommitted);
    saveSetting(FONT_STEP_KEY, fontStepCommitted);
}

// 鼠标设置各行：渲染到面板右栏（#mouse-list），每行一个循环切换按钮——
// 单击左/右行按 上一张 → 下一张 → 已禁用 轮换；单击下方行按 进度条 → 已禁用 轮换；
// 双击中间行按 全屏 → 已禁用 轮换；右键单击行按 侧栏开关 → 已禁用 轮换（两态都不弹系统菜单）；
// 左键长按 / 右键长按行按 拖动 → 缩放 → 已禁用 轮换（两行独立，允许选成同一动作）。带古典引导线；仍遵循草稿态（点「保存」才生效）。
function renderClickNavRows() {
    mouseList.innerHTML = '';
    const rows = [
        ['单击图片左侧', 'left', CLICK_NAV_OPTIONS],
        ['单击图片右侧', 'right', CLICK_NAV_OPTIONS],
        ['单击图片下方', 'mid', CLICK_NAV_MID_OPTIONS],
        ['双击图片中间', 'dbl', CLICK_NAV_DBL_OPTIONS],
        ['左键按住拖拽', 'dragLeft', CLICK_NAV_DRAGBTN_OPTIONS],
        ['右键按住拖拽', 'dragRight', CLICK_NAV_DRAGBTN_OPTIONS],
        ['右键单击', 'rclick', CLICK_NAV_RCLICK_OPTIONS],
    ];
    rows.forEach(([label, side, options]) => {
        const li = document.createElement('li');
        li.className = 'shortcut-row';

        const action = document.createElement('span');
        action.className = 'shortcut-action';
        action.textContent = label;

        const leader = document.createElement('span');
        leader.className = 'shortcut-leader';

        // 循环按钮：点击推进到本行 options 的下一项（末尾回到第一项）
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'shortcut-cycle';
        btn.title = '点击切换：' + options.map((o) => o.label).join(' / ');
        btn.textContent = (options.find((o) => o.value === clickDraft[side]) || {}).label || clickDraft[side];
        // 阻止冒泡：避免触发面板「点其它位置退出编辑」以及遮罩关闭
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const i = options.findIndex((o) => o.value === clickDraft[side]);
            const next = options[(i + 1) % options.length];
            clickDraft[side] = next.value;
            btn.textContent = next.label;
        });

        li.append(action, leader, btn);
        mouseList.appendChild(li);
    });

    // ===== 预览图大小（接线到侧栏缩略图盒子尺寸；点「保存」生效，记住并恢复）=====
    // 标题行：纯文字，无按钮、无引导点线
    const sizeTitleRow = document.createElement('li');
    sizeTitleRow.className = 'shortcut-row';
    const sizeTitleText = document.createElement('span');
    sizeTitleText.className = 'shortcut-action';
    sizeTitleText.textContent = '调整侧栏中预览图的大小：';
    sizeTitleRow.appendChild(sizeTitleText);
    mouseList.appendChild(sizeTitleRow);

    // 第二行：与“播放速度”同款轨道+滑块（档数随 THUMB_SIZES 长度，当前 7 档：小/较小/中/较大/大/特大/超大），拖动只改草稿、点「保存」才生效
    const sizeRow = document.createElement('li');
    sizeRow.className = 'shortcut-row size-slider-row';

    const sliderWrap = document.createElement('div');
    sliderWrap.className = 'size-slider-wrap';
    const sizeRange = document.createElement('input');
    sizeRange.type = 'range';
    sizeRange.min = '0';
    sizeRange.max = String(THUMB_SIZES.length - 1);   // 最大档由数组长度自动推导
    sizeRange.step = '1';
    sizeRange.value = String(thumbStepDraft);   // 反映当前草稿档（打开面板时由生效档复制）
    sizeRange.className = 'size-range';
    const sizeTicks = document.createElement('div');
    sizeTicks.className = 'slider-ticks size-ticks';   // size-ticks：额外补上最右“超大”一档的刻度
    sizeTicks.style.setProperty('--tick-intervals', String(THUMB_SIZES.length - 1));   // 刻度数 = 档数减一
    sliderWrap.append(sizeRange, sizeTicks);

    const sizeValue = document.createElement('span');
    sizeValue.className = 'size-value';
    sizeValue.textContent = SIZE_LABELS[thumbStepDraft];
    // 拖动只改草稿并更新右侧文字；实际盒子尺寸在点「保存」(commitThumbStep) 后才变更
    sizeRange.addEventListener('input', () => {
        thumbStepDraft = Math.min(Math.max(Number(sizeRange.value), 0), SIZE_LABELS.length - 1);
        sizeValue.textContent = SIZE_LABELS[thumbStepDraft];
    });

    sizeRow.append(sliderWrap, sizeValue);
    mouseList.appendChild(sizeRow);

    // ===== 侧栏默认列数（接线到 refitSidebarWidth 的列数因子；点「保存」生效，记住并恢复）=====
    // 标题行：纯文字，无按钮、无引导点线
    const colsTitleRow = document.createElement('li');
    colsTitleRow.className = 'shortcut-row';
    const colsTitleText = document.createElement('span');
    colsTitleText.className = 'shortcut-action';
    colsTitleText.textContent = '调整侧栏预览图默认列数：';
    colsTitleRow.appendChild(colsTitleText);
    mouseList.appendChild(colsTitleRow);

    // 滑块行：与“预览图大小”同款轨道+滑块，档位 1~8 直接用数字，右侧显示数字；拖动只改草稿，点「保存」才生效
    const colsRow = document.createElement('li');
    colsRow.className = 'shortcut-row size-slider-row';
    const colsWrap = document.createElement('div');
    colsWrap.className = 'size-slider-wrap';
    const colsRange = document.createElement('input');
    colsRange.type = 'range';
    colsRange.min = String(SIDEBAR_COLS_MIN);
    colsRange.max = String(SIDEBAR_COLS_MAX);
    colsRange.step = '1';
    colsRange.value = String(colsDraft);   // 反映当前草稿列数（打开面板时由生效值复制）
    colsRange.className = 'size-range';
    const colsTicks = document.createElement('div');
    colsTicks.className = 'slider-ticks size-ticks';   // size-ticks：额外补上最右一档的刻度
    colsTicks.style.setProperty('--tick-intervals', String(SIDEBAR_COLS_MAX - SIDEBAR_COLS_MIN));   // 刻度数 = 档数减一
    colsWrap.append(colsRange, colsTicks);
    const colsValue = document.createElement('span');
    colsValue.className = 'size-value';
    colsValue.textContent = String(colsDraft);
    // 拖动只改草稿并更新右侧数字；实际列数在点「保存」(commitCols) 后才变更
    colsRange.addEventListener('input', () => {
        colsDraft = clampCols(colsRange.value);
        colsValue.textContent = String(colsDraft);
    });
    colsRow.append(colsWrap, colsValue);
    mouseList.appendChild(colsRow);

    // ===== 字体大小（五档：小/中/大/特大/超大，默认「中」；「小」「中」已接线，点「保存」改 --font-offset）=====
    // 标题行：纯文字，无按钮、无引导点线
    const fontTitleRow = document.createElement('li');
    fontTitleRow.className = 'shortcut-row';
    const fontTitleText = document.createElement('span');
    fontTitleText.className = 'shortcut-action';
    fontTitleText.textContent = '调整字体大小：';
    fontTitleRow.appendChild(fontTitleText);
    mouseList.appendChild(fontTitleRow);

    // 滑块行：与“预览图大小”同款轨道+滑块（5 档：小/中/大/特大/超大），右侧显示档位文字；
    // 拖动只改草稿并更新右侧文字；点「保存」才由 commitFontStep 应用 --font-offset（小/中已接线，其余暂按基准）
    const fontRow = document.createElement('li');
    fontRow.className = 'shortcut-row size-slider-row';
    const fontWrap = document.createElement('div');
    fontWrap.className = 'size-slider-wrap';
    const fontRange = document.createElement('input');
    fontRange.type = 'range';
    fontRange.min = '0';
    fontRange.max = String(FONT_SIZE_LABELS.length - 1);   // 最大档由数组长度自动推导
    fontRange.step = '1';
    fontRange.value = String(fontStepDraft);   // 反映当前草稿档（默认「中」）
    fontRange.className = 'size-range';
    const fontTicks = document.createElement('div');
    fontTicks.className = 'slider-ticks size-ticks';   // size-ticks：补上最右一档的刻度
    fontTicks.style.setProperty('--tick-intervals', String(FONT_SIZE_LABELS.length - 1));   // 刻度数 = 档数减一
    fontWrap.append(fontRange, fontTicks);
    const fontValue = document.createElement('span');
    fontValue.className = 'size-value';
    fontValue.textContent = FONT_SIZE_LABELS[fontStepDraft];
    fontRange.addEventListener('input', () => {
        fontStepDraft = Math.min(Math.max(Number(fontRange.value), 0), FONT_SIZE_LABELS.length - 1);
        fontValue.textContent = FONT_SIZE_LABELS[fontStepDraft];
    });
    fontRow.append(fontWrap, fontValue);
    mouseList.appendChild(fontRow);
}

function openShortcutPanel() {
    draft = { ...committed }; // 每次打开都从生效态复制草稿，未保存的改动不会残留
    clickDraft = { ...clickCommitted }; // 点击翻页配置同样重置为生效态的草稿
    thumbStepDraft = thumbStepCommitted; // 预览图大小档同样重置为生效档
    colsDraft = colsCommitted; // 侧栏默认列数草稿同样重置为生效值
    fontStepDraft = fontStepCommitted; // 字体大小档草稿同样重置为生效档
    exitEditMode();
    renderShortcuts();
    shortcutOverlay.classList.add('open');
}

function closeShortcutPanel() {
    exitEditMode();
    shortcutOverlay.classList.remove('open');
}

function saveShortcuts() {
    committed = { ...draft }; // 仅"保存"时草稿才提交为生效态
    rebuildLookup();
    persistCommitted();
    clickCommitted = { ...clickDraft }; // 提交点击翻页配置并持久化
    persistClickNav();
    commitThumbStep(); // 提交预览图大小草稿档 → 应用到缩略图盒子 + 重算侧栏宽度 + 持久化
    commitCols(); // 提交列数草稿 → 更新全局列数 + 重算侧栏默认宽度 + 持久化
    commitFontStep(); // 提交字号档草稿 → 应用 --font-offset（小/中已接线）+ 持久化
    closeShortcutPanel();
}

function enterEditMode(id) {
    if (editingId === id) return;
    exitEditMode();
    editingId = id;
    const box = keyBoxById[id];
    box.classList.remove('conflict');
    box.classList.add('editing');
    box.textContent = '…'; // 等待按下新键
}

function exitEditMode() {
    if (editingId === null) return;
    const box = keyBoxById[editingId];
    box.classList.remove('editing');
    box.textContent = codeToLabel(draft[editingId]); // 还原为草稿中的当前键
    editingId = null;
}

// 编辑态：按下任意键即定稿（单键模型，无需组合、无需等待松开）
function handleEditKey(e) {
    e.preventDefault();
    if (e.key === 'Escape') { exitEditMode(); return; } // Esc 取消本次编辑
    if (e.repeat) return;
    const code = keyToken(e);
    if (!code) return; // 空令牌（异常事件）不录入，避免显示空白
    // 撞键：该键已被其它动作占用 → 红框抖动，保持编辑态等待重输
    for (const [k, v] of Object.entries(draft)) {
        if (k !== editingId && v === code) { flashConflict(editingId); return; }
    }
    draft[editingId] = code;
    exitEditMode(); // 录入完成：停止闪烁并显示新键
}

function flashConflict(id) {
    const box = keyBoxById[id];
    box.classList.remove('conflict');
    void box.offsetWidth; // 强制重绘以重新触发抖动动画
    box.classList.add('conflict');
    setTimeout(() => box.classList.remove('conflict'), 400);
}

document.getElementById('shortcut-settings-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    settingsPanel.classList.remove('open'); // 打开快捷键面板时，设置小面板自动收起
    openShortcutPanel();
});

document.getElementById('shortcut-close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeShortcutPanel();
});

// 底部按钮：保存 / 取消
document.getElementById('shortcut-save').addEventListener('click', (e) => {
    e.stopPropagation();
    saveShortcuts();
});

document.getElementById('shortcut-cancel').addEventListener('click', (e) => {
    e.stopPropagation();
    closeShortcutPanel();
});

// 点击遮罩空白处关闭
shortcutOverlay.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target === shortcutOverlay) closeShortcutPanel();
});

// 点击面板内其它位置退出当前编辑态（键位盒子自身已 stopPropagation，不会误触）
shortcutPanel.addEventListener('click', () => { exitEditMode(); });

// 初始化：载入生效态 → 复制草稿 → 建反查表 → 渲染
committed = loadCommitted();
draft = { ...committed };
rebuildLookup();
renderShortcuts();

// ===== 本地设置存取（localStorage，pywebview 中同样可用，打包后依然有效） =====
function loadSetting(key, fallback) {
    try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : Number(v);
    } catch (e) { return fallback; }
}

function saveSetting(key, value) {
    try { localStorage.setItem(key, String(value)); } catch (e) { /* 忽略 */ }
}

// ===== 设置项生效 + 持久化 =====
const gapSlider = document.getElementById('gap-slider');
const speedSlider = document.getElementById('speed-slider');

function applyGap(value) {
    document.documentElement.style.setProperty('--image-gap', `${value}px`);
    document.getElementById('gap-value').textContent = value;
}

function applySpeed(value) {
    autoScrollSpeed = Number(value); // 播放中也能实时生效（每帧读取）
    document.getElementById('speed-value').textContent = value;
}

gapSlider.addEventListener('input', (e) => {
    applyGap(e.target.value);
    saveSetting('imageviewer.imageGap', e.target.value);
});

speedSlider.addEventListener('input', (e) => {
    applySpeed(e.target.value);
    saveSetting('imageviewer.scrollSpeed', e.target.value);
});

// 启动时恢复上次设置（滑块位置与实际效果同步）
const savedGap = loadSetting('imageviewer.imageGap', 8);
const savedSpeed = loadSetting('imageviewer.scrollSpeed', 40);
gapSlider.value = savedGap;
speedSlider.value = savedSpeed;
applyGap(savedGap);
applySpeed(savedSpeed);

// ===== 全屏模式 =====
// pywebview 环境下使用原生窗口全屏（WebView2 中 DOM Fullscreen API 受限）；
// 浏览器环境回退到 DOM Fullscreen API（便于前端独立调试）。
let isNativeFullscreen = false;

// 开关：进入全屏时自动收起侧栏（仅进入时触发一次；退出全屏不受影响）；持久化并恢复
const collapseFsToggle = document.getElementById('collapse-fullscreen-toggle');
if (loadSetting('imageviewer.collapseOnFullscreen', 0) === 1) collapseFsToggle.checked = true;
collapseFsToggle.addEventListener('change', () => {
    saveSetting('imageviewer.collapseOnFullscreen', collapseFsToggle.checked ? 1 : 0);
});

// 开关：退出全屏时自动展开侧栏（仅退出时触发一次；进入全屏不受影响）；持久化并恢复
const expandFsToggle = document.getElementById('expand-exitfullscreen-toggle');
if (loadSetting('imageviewer.expandOnExitFullscreen', 0) === 1) expandFsToggle.checked = true;
expandFsToggle.addEventListener('change', () => {
    saveSetting('imageviewer.expandOnExitFullscreen', expandFsToggle.checked ? 1 : 0);
});

// 进入全屏的一次性行为：开关开启且侧栏未收起时才收起（已收起则不动作）
function onEnterFullscreen() {
    if (collapseFsToggle.checked && !sidebar.classList.contains('collapsed')) {
        toggleSidebar();
    }
}

// 退出全屏的一次性行为：开关开启且侧栏处于收起态时才展开（已展开则不动作）
function onExitFullscreen() {
    if (expandFsToggle.checked && sidebar.classList.contains('collapsed')) {
        toggleSidebar();
    }
}

function toggleFullscreen() {
    if (window.pywebview && window.pywebview.api) {
        // pywebview 原生全屏
        isNativeFullscreen = !isNativeFullscreen;
        window.pywebview.api.toggle_fullscreen();
        if (isNativeFullscreen) onEnterFullscreen();   // 翻转为“进入”
        else onExitFullscreen();                        // 翻转为“退出”
    } else {
        // 浏览器回退：DOM Fullscreen API
        if (document.fullscreenElement) {
            document.exitFullscreen();                 // 退出
            onExitFullscreen();
        } else {
            document.getElementById('app').requestFullscreen();
            onEnterFullscreen();                       // 进入
        }
    }
}

function exitFullscreenIfActive() {
    if (isNativeFullscreen) {
        isNativeFullscreen = false;
        window.pywebview.api.toggle_fullscreen();
        onExitFullscreen();                            // Esc 退出原生全屏
        return true;
    }
    if (document.fullscreenElement) {
        document.exitFullscreen();
        onExitFullscreen();                            // Esc 退出 DOM 全屏
        return true;
    }
    return false;
}

document.getElementById('btn-fullscreen').addEventListener('click', toggleFullscreen);

// ===== 键盘绑定（单键：keydown 时用 keyToken(e) 求令牌后查表触发） =====
const KEY_SCROLL_STEP = 30; // ↑↓ 微调步长（像素）

// 键盘 next/prev 的长按连发：不进 REPEATABLE（屏蔽 OS 系统键重复、避免连翻失控），
// 改用自定节奏的 startHoldRepeat（与工具栏按钮同款）。id → 停止函数。
const HOLD_REPEATABLE = new Set(['next', 'prev']);
const holdStopById = {};

document.addEventListener('keydown', (e) => {
    // 1) 改键编辑态：按下即录入（单键定稿），仅"保存"后才真正生效
    if (editingId !== null) { handleEditKey(e); return; }

    // 2) 面板打开但未编辑：Esc 关闭面板，其余按键一律拦截，避免误触发背后功能
    if (shortcutOverlay.classList.contains('open')) {
        e.preventDefault();
        if (e.key === 'Escape') closeShortcutPanel();
        return;
    }

    // 2.5) Esc 退出全屏（原生全屏模式下无浏览器自动处理，需手动退出）
    if (e.key === 'Escape' && exitFullscreenIfActive()) return;

    // 3) 普通浏览：焦点在滑块等输入控件时，按键留给控件自身
    if (e.target.tagName === 'INPUT') return;

    const id = codeToId.get(keyToken(e));
    if (!id || !ACTION_HANDLERS[id]) return;

    // next / prev：走自定节奏的长按连发（首次按下起手、松手在 keyup 停；屏蔽 OS 重复键）
    if (HOLD_REPEATABLE.has(id)) {
        e.preventDefault();
        if (e.repeat) return;                       // 重复交给定时器驱动
        if (!holdStopById[id])                      // 已在手则不叠加
            holdStopById[id] = startHoldRepeat(() => ACTION_HANDLERS[id](false));
        return;
    }

    // toggle 类动作长按只触发一次；滚动类允许长按连续触发
    if (e.repeat && !REPEATABLE_ACTIONS.has(id)) return;

    e.preventDefault();
    // 传 e.repeat：长按重复时 zoom 走小步长（isHold），首次按下为 false 走满步；其余动作忽略此参
    ACTION_HANDLERS[id](e.repeat);
});

// 松手 / 窗口失焦 → 停掉对应动作的长按连发
document.addEventListener('keyup', (e) => {
    const id = codeToId.get(keyToken(e));
    if (id && holdStopById[id]) { holdStopById[id](); delete holdStopById[id]; }
});
window.addEventListener('blur', () => {
    for (const id of Object.keys(holdStopById)) { holdStopById[id](); delete holdStopById[id]; }
});
