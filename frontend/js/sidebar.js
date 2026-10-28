// ===== 侧栏目录导航（假数据预览） =====
// 单击进入子目录 / 返回上级；单击图片缩略图进入预览（调用 main.js 的 openImagesAt）。
// 上次所在目录通过 localStorage 记住，刷新（=重启应用）后恢复；
// 图片区始终从空状态开始，只在单击图片缩略图时切换内容。

const dirPathEl = document.getElementById('dir-path');
const dirListEl = document.getElementById('dir-list');
const thumbGridEl = document.getElementById('thumb-grid');
// 侧栏滚动容器：进入/返回目录、切换视图时的滚动位置都基于它。
const sidebarContentEl = document.getElementById('sidebar-content');

// 目录滚动位置记忆：进入子目录时记下父目录当时的滚动偏移，返回父目录时精确还原到“进入点”；
// 首次访问（无记录）则回顶部。收藏清单用一个哨兵 key 纳入同一套机制。
const FAV_LIST_KEY = '__fav_list__';
const dirScrollMemory = {};
let displayedPath = null;      // 当前侧栏正在展示的视图 key（目录路径 或 收藏清单）
function captureScroll() {
    if (displayedPath !== null && sidebarContentEl) dirScrollMemory[displayedPath] = sidebarContentEl.scrollTop;
}
function restoreScroll(key) {
    if (!sidebarContentEl) return;
    const saved = dirScrollMemory[key];
    sidebarContentEl.scrollTop = saved !== undefined ? saved : 0;
}
// 切标签例外：把切换前的滚动位置原样带到新视图（不套用记忆、避免两页位置不同导致的跳动）；
// 其余（目录进入/返回）：有记录则精确还原到进入点，否则回顶部。
function carryOrRestore(opts, key) {
    if (opts && opts.tabSwitch) {
        if (sidebarContentEl && opts.carryScroll !== undefined) sidebarContentEl.scrollTop = opts.carryScroll;
    } else {
        restoreScroll(key);
    }
}

const STORAGE_KEY = 'imageviewer.lastDir';
const DIR_MODE_KEY = 'imageviewer.dirMode';   // 记住上次关闭时所处的标签：'all' / 'fav'，重启后回到同一标签
const DRIVE_ROOT = ''; // 虚拟根级：盘符列表

// 「全部 / 收藏」分段按钮：记住最近渲染的目录（切回「全部」时用它还原列表）与当前过滤模式
let lastRenderedDir = null;
let dirFilterMode = 'all';   // 'all' | 'fav'（顶部哪个按钮高亮）
let viewingFavList = false;  // 当前侧栏是否正展示「收藏清单」（区别“在收藏标签下浏览某个真实目录”）
let favEntryPath = null;     // 从收藏清单进入的那个目录：在这一层“返回”应回到收藏清单而非文件系统上级
let favBrowseDir = null;     // 收藏标签当前浏览到的目录：null=显示收藏清单，路径=正在浏览该目录（切走再回来可恢复）
let favRenderToken = 0;      // 收藏清单异步渲染令牌：await 期间若又切换视图则丢弃过期结果
// 收藏预览图缓存：dirPath(小写) → 首图 thumb_url（null=无图/扫描失败占位）。仅内存，随应用重启失效
// （thumb_url 含本次运行的随机端口，落 localStorage 下次端口变化后全失效，故不持久化）。
const favPreviewCache = new Map();

// 收藏清单排序方向：true=降序（后收藏在前，默认），false=升序（先收藏在前）。持久化到 localStorage，重启不丢。
// 仅影响“显示顺序”，不改写存储数组（存储数组顺序恒为收藏先后，追加 / 就地移除）。
const FAV_SORT_KEY = 'imageviewer.favSort';
function loadFavSortDesc() {
    try { const v = localStorage.getItem(FAV_SORT_KEY); return v === null ? true : v === 'desc'; }   // 无记录→默认降序
    catch (e) { return true; }
}
function saveFavSortDesc(d) { try { localStorage.setItem(FAV_SORT_KEY, d ? 'desc' : 'asc'); } catch (e) { /* 忽略 */ } }
let favSortDesc = loadFavSortDesc();
const favSortBtn = document.getElementById('fav-sort');   // DOM 已就绪（脚本在 body 末尾），供渲染/交互引用

const FOLDER_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
</svg>`;

const UP_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="9 14 4 9 9 4"></polyline>
    <path d="M20 20v-7a4 4 0 0 0-4-4H4"></path>
</svg>`;

const DRIVE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="22" y1="12" x2="2" y2="12"></line>
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path>
    <line x1="6" y1="16" x2="6.01" y2="16"></line>
    <line x1="10" y1="16" x2="10.01" y2="16"></line>
</svg>`;

const FILE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
    <circle cx="8.5" cy="8.5" r="1.5"></circle>
    <polyline points="21 15 16 10 5 21"></polyline>
</svg>`;

// 收藏星（实心五角）：填色用 currentColor，颜色由 CSS 控制（默认灰=悬浮出现；.faved 黄=已收藏常显）
const STAR_ICON = `<svg class="dir-star" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.94 6.26 6.85.9-5.02 4.8 1.25 6.79L12 17.77 6.03 20.75l1.25-6.79-5.02-4.8 6.85-.9z"></path></svg>`;

// 空集符号 ∅（圆 + 斜线）：收藏目录无图片时，显示在 fav-thumb 灰框中央（stroke=currentColor，颜色/大小由 CSS 控）。
// 斜线两端略探出圆外（标准 ∅ 写法）：端点半径≈ 9.9（圆外沿≈ 9），两头各露一点。
const EMPTY_SET_ICON = `<svg class="fav-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8"></circle><line x1="5" y1="19" x2="19" y2="5"></line></svg>`;

// ===== 收藏目录（点星切换；只持久化路径，「全部」列表不受影响）=====
const FAV_KEY = 'imageviewer.favDirs';

function loadFavDirs() {
    try { return JSON.parse(localStorage.getItem(FAV_KEY)) || []; } catch (e) { return []; }
}
function saveFavDirs(list) {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(list)); } catch (e) { /* 忽略 */ }
}
// Windows 路径大小写不敏感：统一按小写比较，避免同目录因大小写不同被重复收藏
function isFavDir(p) { return loadFavDirs().some(x => x.toLowerCase() === p.toLowerCase()); }
// 存储数组的顺序即“收藏先后”：新收藏追加到末尾，取消则就地移除。
// 不再做“无限期按旧下标回插”：下标会随后续增删漂移，反复收藏/取消后会把目录插到错误位置。
// 但支持“紧邻一步撤销”（favUndo）：取消后紧接着点回同一个目录 → 插回原下标，与收藏清单里
// “星只变色不重渲染”的乐观视图保持一致（否则切走再切回时该目录会突然跳到首位）。
// 撤销窗口只在“紧邻的下一步、且路径相同”时有效：期间有任何其它收藏增删（新收藏/换了另一个取消）
// 都会被覆盖或作废，因此记录的下标永远指向它被删除时的真实位置，不存在漂移。
let favUndo = null;            // { key, index }：最近一次取消收藏的原位置；null=无待撤销
function toggleFavorite(p) {
    const list = loadFavDirs();
    const key = p.toLowerCase();
    const i = list.findIndex(x => x.toLowerCase() === key);
    if (i === -1) {
        if (favUndo && favUndo.key === key) {
            // 上一步刚取消的就是它 → 撤销：插回原下标（min 仅防御性兜底，正常时必在范围内）
            list.splice(Math.min(favUndo.index, list.length), 0, p);
            favUndo = null;
        } else {
            list.push(p);      // 全新收藏（或撤销窗口已失效）→ 追加到末尾
            favUndo = null;    // 新收藏作废撤销窗口
        }
        saveFavDirs(list); return true;
    }
    favUndo = { key, index: i };                  // 记录取消位置，供紧邻一步撤销；再取消别的会自动顶掉
    list.splice(i, 1); saveFavDirs(list); return false;               // 取消收藏
}
function baseName(p) {
    const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
    return parts[parts.length - 1] || p;
}

// 从「收藏」清单点击行进入该目录：只浏览内容，顶部按钮保持在「收藏」不跳回「全部」。
function openDir(path) {
    favEntryPath = path;       // 记住入口：在这一层点“返回”回收藏清单
    renderDirectory(path);     // renderDirectory 会把 viewingFavList 置 false（已在浏览真实目录）
}

// 渲染「收藏」列表：每行 [预览图] 目录名（预览图取该收藏目录自然排序首图）；异步并发拉取，空则占位文字
async function renderFavList(opts) {
    opts = opts || {};
    if (!opts.tabSwitch) captureScroll();   // 记录离开视图的滚动位置（此刻旧内容仍在，读得到）
    const token = ++favRenderToken;         // 本次渲染令牌；若 await 期间又发起别的渲染则作废
    // 按当前方向排列：降序=后收藏在前（反转存储数组），升序=先收藏在前（存储原序）。
    const favs = favSortDesc ? loadFavDirs().slice().reverse() : loadFavDirs();
    // 预览图先查内存缓存（favPreviewCache），命中的秒开、无需扫描；只对未命中的目录并发 listDirectory。
    // 预取期间保持旧视图原样，不做“先清空→await→再填充”，避免侧栏空白导致面包屑/缩略图闪/抖一下。
    const previews = new Array(favs.length).fill(null);
    const pending = [];
    favs.forEach((p, i) => {
        const key = p.toLowerCase();
        if (favPreviewCache.has(key)) previews[i] = favPreviewCache.get(key);   // list_directory 的 images 已按自然序排好，取 [0]
        else pending.push({ i, path: p, key });
    });
    if (pending.length) {
        // 单个目录扫描失败（无权限/已删除）catch 为 null → 记为无图占位，本次运行不再重复扫描
        const infos = await Promise.all(pending.map(x => MockAPI.listDirectory(x.path).catch(() => null)));
        // await 期间可能已切到「全部」或进入某目录：令牌过期则丢弃，避免把收藏行插进别的视图
        if (token !== favRenderToken) return;
        infos.forEach((info, k) => {
            const images = info && info.images;
            const url = (images && images.length) ? images[0].thumb_url : null;
            favPreviewCache.set(pending[k].key, url);
            previews[pending[k].i] = url;
        });
    }

    // —— 以下全部同步完成，浏览器只绘制最终态，不闪不抖 ——
    viewingFavList = true;      // 正在展示收藏清单（此时取消收藏需实时重渲染移除该行）
    favEntryPath = null;        // 回到收藏清单本身，清除“从收藏进入”的上下文
    favBrowseDir = null;        // 收藏标签位置重置为“清单”
    dirPathEl.textContent = '';
    const crumb = document.createElement('span');
    crumb.className = 'dir-path-text';
    crumb.textContent = '收藏列表';
    dirPathEl.appendChild(crumb);
    dirListEl.innerHTML = '';
    thumbGridEl.innerHTML = '';
    if (favs.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'dir-empty';
        empty.textContent = '这里空空的';
        dirListEl.appendChild(empty);
    } else {
        for (let i = 0; i < favs.length; i++) {
            dirListEl.appendChild(createFavEntry(baseName(favs[i]), previews[i], favs[i]));
        }
    }
    if (favSortBtn) favSortBtn.classList.toggle('show', favs.length > 0);   // 仅收藏清单(非空)时显示排序按钮
    carryOrRestore(opts, FAV_LIST_KEY); displayedPath = FAV_LIST_KEY;   // 还原/记录收藏清单滚动位置
}

// 收藏行：复用 dir-item（悬浮/定位/黄星），加 fav-item 覆盖成「预览图 + 垂直居中名字」。
// 长按/单击整行 → 拖动重排 或 进入该目录（见 makeFavDraggable）；点右侧星占位区 → 切换收藏。
function createFavEntry(name, previewUrl, path) {
    const li = document.createElement('li');
    li.className = 'dir-item fav-item';
    li.dataset.favPath = path;      // 拖动重排时据此读回每行对应的收藏路径

    const thumb = document.createElement('div');
    thumb.className = 'fav-thumb';
    if (previewUrl) {
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.alt = '';
        img.src = previewUrl;
        img.addEventListener('error', () => { img.remove(); thumb.innerHTML = EMPTY_SET_ICON; });   // 加载失败 → 也回退成空集图标
        thumb.appendChild(img);
    } else {
        thumb.innerHTML = EMPTY_SET_ICON;   // 目录无图片 → 灰底中央显示空集(∅)图标
    }
    li.appendChild(thumb);

    const span = document.createElement('span');
    span.className = 'dir-name';
    span.textContent = name;
    li.appendChild(span);

    // 黄星常驻（取消收藏入口）。用 .fav-star-slot 容器包住星：容器是 flex 子项、纵向撑满整行、
    // 横向含右侧空隙，点击挂在容器上 → 星占的那整块右侧区域（上/下/右）都可点，星本体尺寸不变。
    const slot = document.createElement('span');
    slot.className = 'fav-star-slot';
    slot.innerHTML = STAR_ICON;
    const star = slot.querySelector('.dir-star');
    star.classList.add('faved');
    slot.addEventListener('mousedown', (e) => e.stopPropagation());   // 星占位区不发起长按拖动
    slot.addEventListener('click', (e) => {
        e.stopPropagation();
        const nowFaved = toggleFavorite(path);        // 黄→灰同时从收藏数据移除；灰→黄重新加入（可撤销）
        star.classList.toggle('faved', nowFaved);     // 只翻转颜色（黄/灰），不重渲染 → 行与滚动位置都不动
    });
    li.appendChild(slot);

    makeFavDraggable(li, path);   // 长按拖动重排；未满长按阈值的短按 = 进入目录
    return li;
}

// ===== 收藏清单「长按拖动重排」 =====
// 交互链：按下整行 → 满 FAV_DRAG_DELAY = “拾起”：原行高亮留槽（拾起后再移动鼠标也不中断），
// 同时一个半透明幽灵行（原行克隆：只显示 3 行高、无星星、字号不变）跟随鼠标，光标变 grabbing；
// 移动 → 白线实时指示松手会落进哪条缝（含被拖行自己的上/下缝：落在自身缝 = 回原位，不产生改动）；
// 拖到列表上/下边缘附近自动滚动，方便把行拖到当前屏幕之外的位置（收藏清单很长时尤需）；
// 松手：白线在有效位 → 重排并持久化 + 重渲染，否则取消；未满阈值就松开 → 照常进入目录（原单击）。
// 导航不再依赖原生 click（mousedown 已 preventDefault 禁掉原生图片拖拽），由 mouseup 手动判定。
// 降序显示是存储数组的镜像：全部先在“视觉顺序”里算，最后一步反转映射回存储数组。
const FAV_DRAG_DELAY = 200;   // 长按多少 ms 拾起该行
const FAV_SCROLL_EDGE = 40;   // 拖到距滚动容器上/下边缘多少 px 内触发自动滚动
const FAV_SCROLL_STEP = 8;    // 自动滚动时每帧滚动的像素
let favDragRow = null;        // 当前被拖的 li（同一时刻至多一个拖拽）

function makeFavDraggable(li, path) {
    li.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || favDragRow) return;
        e.preventDefault();                       // 禁原生图片拖拽/文字选中；导航改由下方 mouseup 判定
        const startY = e.clientY;                 // 按下纵坐标（拾起时供初始定位参考）
        let lastY = startY;                       // 最近一次鼠标纵坐标（自动滚动时据此重画白线）
        let picked = false;                       // 是否已长按“拾起”
        let lineEl = null;                        // 插入白线（拾起时才创建）
        let ghostEl = null;                       // 跟鼠标的半透明克隆行（拾起时创建）
        let ghostOY = 0;                          // 幽灵行纵向抓取偏移（自身半高，使其垂直居中于指针）
        let insertAt = -1;                        // 白线指向的视觉插入位（-1 = 尚未画线）
        let scrollDir = 0;                        // 自动滚动方向：-1 上 / 0 停 / +1 下
        let scrollRaf = null;                     // 自动滚动 rAF 句柄

        const timer = setTimeout(() => {
            picked = true;
            favDragRow = li;
            // 先克隆再给原行加高亮态：幽灵保持正常外观（靠 CSS 压到 3 行高、隐星）；挂 body 下固定定位跟手
            const r = li.getBoundingClientRect();
            ghostEl = li.cloneNode(true);
            ghostEl.removeAttribute('style');
            ghostEl.classList.add('fav-drag-ghost');
            ghostEl.style.width = Math.round(r.width * 0.7) + 'px';   // 迷你目录宽=侧栏(行)宽的 70%
            ghostEl.style.left = Math.round(r.left + r.width * 0.15) + 'px';   // 水平居中于行（两侧各留 15%）：沿侧栏中心竖线上下移动
            document.body.appendChild(ghostEl);
            // 幽灵行已被 CSS 压成 3 行高（比原行矮）：纵向抓取偏移取自身半高，使其垂直居中于指针
            ghostOY = ghostEl.getBoundingClientRect().height / 2;
            li.classList.add('fav-dragging');     // 原行高亮：此行正被抓起
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'grabbing';
            positionGhost(lastY);
            lineEl = document.createElement('div');
            lineEl.className = 'fav-drop-line';
            dirListEl.appendChild(lineEl);
            startAutoScroll();
        }, FAV_DRAG_DELAY);

        function positionGhost(y) {
            if (!ghostEl) return;
            ghostEl.style.top = (y - ghostOY) + 'px';   // left 已在拾起时钉死，只上下移动
        }
        function onMove(ev) {
            lastY = ev.clientY;
            // 拾起前移动不再取消长按：长按过程中手抖/小幅移动仍应正常进入拖动态
            if (!picked) return;
            positionGhost(ev.clientY);
            updateLine(ev.clientY);
            scrollDir = computeScrollDir(ev.clientY);
        }
        // 自动滚动：拖动中鼠标靠近滚动容器上/下边缘时逐帧滚动，把远处的行“拉”到指针下；
        // 指针不动、内容在动，故滚动后需按最后一次的 clientY 重算白线
        function computeScrollDir(clientY) {
            if (!sidebarContentEl) return 0;
            const rect = sidebarContentEl.getBoundingClientRect();
            if (clientY < rect.top + FAV_SCROLL_EDGE) return -1;
            if (clientY > rect.bottom - FAV_SCROLL_EDGE) return 1;
            return 0;
        }
        function scrollStep() {
            if (!picked) { scrollRaf = null; return; }
            if (scrollDir !== 0) {
                const before = sidebarContentEl.scrollTop;
                sidebarContentEl.scrollTop += scrollDir * FAV_SCROLL_STEP;
                if (sidebarContentEl.scrollTop !== before) updateLine(lastY);   // 内容真动了才重画线
            }
            scrollRaf = requestAnimationFrame(scrollStep);
        }
        function startAutoScroll() { if (scrollRaf == null) scrollRaf = requestAnimationFrame(scrollStep); }
        function stopAutoScroll() { if (scrollRaf != null) { cancelAnimationFrame(scrollRaf); scrollRaf = null; } }
        function onUp(ev) {
            clearTimeout(timer);
            stopAutoScroll();
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            window.removeEventListener('blur', onUp);
            if (picked) {
                if (insertAt >= 0) commitDrop();
                if (lineEl) lineEl.remove();
                if (ghostEl) ghostEl.remove();
                li.classList.remove('fav-dragging');
                document.body.style.userSelect = '';
                document.body.style.cursor = '';
                favDragRow = null;
                return;
            }
            // 未拾起即松开：仍在行内 → 进入目录（等价原单击）；blur 兜底时坐标缺失，自然不进
            const r = li.getBoundingClientRect();
            if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) openDir(path);
        }
        // 按鼠标 Y 与各行的垂直中线比较，得出“落在哪两行之间”；所有缝隙（含自身上/下缝）都画线，
        // 保证拖动全程反馈连续；落在自身缝等于回原位，由 commitDrop 判无效不改数据
        function updateLine(clientY) {
            insertAt = -1;
            lineEl.style.display = 'none';
            if (!li.isConnected) return;                    // 视图已切换（异常态）：不画线
            const rows = Array.from(dirListEl.querySelectorAll('.fav-item'));
            const from = rows.indexOf(li);
            if (from === -1 || rows.length < 2) return;     // 行已被外部移除 / 只有一行：无可重排
            let at = rows.length;                           // 默认落在最后一行之下
            for (let k = 0; k < rows.length; k++) {
                const r = rows[k].getBoundingClientRect();
                if (clientY < r.top + r.height / 2) { at = k; break; }
            }
            const cont = dirListEl.getBoundingClientRect();
            let y;
            if (at === 0) y = rows[0].getBoundingClientRect().top;
            else if (at === rows.length) y = rows[rows.length - 1].getBoundingClientRect().bottom;
            else y = (rows[at - 1].getBoundingClientRect().bottom + rows[at].getBoundingClientRect().top) / 2;
            insertAt = at;
            lineEl.style.top = Math.round(y - cont.top) + 'px';
            lineEl.style.display = 'block';
        }
        // 白线位置是“含被拖行”的视觉插入位：先摘自己、按 to>from 修正下标，再插回；
        // 降序显示时再把视觉顺序反转回存储数组序。重排使旧撤销下标失效 → favUndo 作废。
        function commitDrop() {
            const rows = Array.from(dirListEl.querySelectorAll('.fav-item'));
            const from = rows.indexOf(li);
            if (from === -1) return;
            if (insertAt === from || insertAt === from + 1) return;   // 落在自身缝：回原位，不写数据不重渲染
            const vis = rows.map(r => r.dataset.favPath);
            const moved = vis.splice(from, 1)[0];
            vis.splice(insertAt > from ? insertAt - 1 : insertAt, 0, moved);
            saveFavDirs(favSortDesc ? vis.reverse() : vis);
            favUndo = null;
            renderFavList();   // 重渲染（滚动位置由既有 capture/restore 机制保持）
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        window.addEventListener('blur', onUp);    // 失焦兜底：拖到一半切窗口也能收尾
    });
}

async function renderDirectory(dirPath, opts) {
    opts = opts || {};
    if (!opts.tabSwitch) captureScroll();   // 切标签例外：不记录离开位置、不套用记忆
    favRenderToken++;               // 作废可能在途的收藏预取，避免它 await 回来后串画面
    const info = await MockAPI.listDirectory(dirPath);

    dirPathEl.textContent = '';
    const pathSpan = document.createElement('span');
    pathSpan.className = 'dir-path-text';
    pathSpan.textContent = info.path === DRIVE_ROOT ? '此电脑' : info.path;
    dirPathEl.appendChild(pathSpan);
    dirListEl.innerHTML = '';
    thumbGridEl.innerHTML = '';

    // 返回上一级（根级即盘符列表时没有上一级）；
    // 若当前正是“从收藏清单进入”的那个目录（且处于收藏标签），返回按钮改为回收藏清单。
    if (dirFilterMode === 'fav' && favEntryPath !== null && info.path === favEntryPath) {
        dirListEl.appendChild(createEntry('返回收藏列表', UP_ICON, 'up', () => renderFavList(), null));
    } else if (info.parent !== null) {
        dirListEl.appendChild(createEntry('返回上一级目录', UP_ICON, 'up', () => renderDirectory(info.parent), null));
    }

    // 子目录（根级时为盘符，用硬盘图标）
    const isDriveRoot = info.path === DRIVE_ROOT;
    for (const name of info.dirs) {
        const fullPath = isDriveRoot ? name : joinPath(info.path, name);
        const type = isDriveRoot ? 'drive' : 'dir';
        const icon = isDriveRoot ? DRIVE_ICON : FOLDER_ICON;
        dirListEl.appendChild(createEntry(name, icon, type, () => renderDirectory(fullPath), null, isDriveRoot ? null : fullPath));
    }

    // 图片文件：缩略图网格（固定盒子 + 正下方序号）；单击进入预览并定位到该图。
    // 名字统一显示为自然序序号 1/2/3…（仅显示，真实文件名不变，点击仍按真实名打开）。
    info.images.forEach((img, i) => {
        thumbGridEl.appendChild(createThumbItem(img.name, img.thumb_url, info.path, i + 1));
    });

    // 记住浏览位置：收藏标签下记到 favBrowseDir（切走再回来恢复该目录）；
    // 全部标签下记到 lastRenderedDir + 持久化 STORAGE_KEY（重启恢复）。两者互不污染。
    if (dirFilterMode === 'fav') {
        favBrowseDir = info.path;
    } else {
        try { localStorage.setItem(STORAGE_KEY, info.path); } catch (e) { /* file:// 下异常则忽略 */ }
        lastRenderedDir = info.path;
    }
    viewingFavList = false;        // renderDirectory 渲染的是真实目录内容，不再是收藏清单
    // 还原滚动位置：切标签=原样带走切换前位置(不跳)；目录导航=有记录回到进入点，否则回顶部
    if (favSortBtn) favSortBtn.classList.remove('show');   // 浏览真实目录（含「全部」）时隐藏排序按钮
    carryOrRestore(opts, info.path); displayedPath = info.path;
}

function joinPath(parent, name) {
    return parent.endsWith('\\') ? parent + name : `${parent}\\${name}`;
}

function createEntry(name, iconSvg, type, onClick, onDblClick, favKey) {
    const li = document.createElement('li');
    li.className = `dir-item ${type}`;
    li.innerHTML = iconSvg;
    const span = document.createElement('span');
    span.className = 'dir-name';
    span.textContent = name; // 不用 innerHTML，防路径中的特殊字符
    li.appendChild(span);
    if (type === 'dir' && favKey) {
        // 普通目录行右侧收藏星：默认隐藏、悬浮显灰；已收藏则加 .faved（黄色常驻）。
        // 点星 stopPropagation → 只切换收藏、不进入目录；点行其它处才导航。
        li.insertAdjacentHTML('beforeend', STAR_ICON);
        const star = li.querySelector('.dir-star');
        if (isFavDir(favKey)) star.classList.add('faved');
        star.addEventListener('click', (e) => {
            e.stopPropagation();
            const nowFaved = toggleFavorite(favKey);
            star.classList.toggle('faved', nowFaved);        // 黄星常驻 / 取消即时更新
            if (viewingFavList) renderFavList();     // 在收藏清单里取消 → 实时移除该行（浏览真实目录时不误刷）
        });
    }
    if (onClick) li.addEventListener('click', onClick);
    if (onDblClick) li.addEventListener('dblclick', onDblClick);
    return li;
}

// 图片缩略图格子：固定盒子内放预览图（object-fit:contain 使长图顶高、宽图顶两侧），盒子正下方显示自然序序号（1/2/3…，非真实文件名）。
// 缩略图由后端 /thumb 路由提供（长边≤300px JPEG）。displayIndex 缺省时回退显示真实名（兼容其它调用）。
// 单击即进入预览（与目录“单击进入”一致），按真实名定位。
function createThumbItem(name, thumbUrl, dirPath, displayIndex) {
    const item = document.createElement('div');
    item.className = 'thumb-item';

    const box = document.createElement('div');
    box.className = 'thumb-box';
    const img = document.createElement('img');
    img.loading = 'lazy';    // 只加载滚进视口的缩略图
    img.decoding = 'async';  // 解码不阻塞主线程
    img.alt = '';            // 置空：不显示悬停提示（不弹出真实文件名）
    img.src = thumbUrl;
    img.addEventListener('error', () => { img.remove(); }); // 缩略图加载失败则留空盒子
    box.appendChild(img);

    const label = document.createElement('span');
    label.className = 'thumb-name';
    label.textContent = displayIndex !== undefined ? displayIndex : name;  // 只显示序号；无序号(其它调用)回退真实名

    item.append(box, label);
    item.addEventListener('click', () => openImagesAt(dirPath, name));
    return item;
}

// ===== 「全部 / 收藏」分段按钮切换 =====
// 全部：显示当前目录列表（用最近渲染路径还原）；收藏：列出已收藏目录（空则占位文字）。
function setDirFilter(mode) {
    dirFilterMode = mode;
    try { localStorage.setItem(DIR_MODE_KEY, mode); } catch (e) { /* 忽略 */ }   // 持久化当前标签，重启后还原
    document.querySelectorAll('#dir-filter .dir-filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === mode);
    });
    // 「全部/收藏」按钮切换例外：不套用两页各自的滚动记忆（避免位置不同来回跳），
    // 直接把切换前的滚动位置原样带到新视图（内容更短时由浏览器自然钳制）。
    const carryScroll = sidebarContentEl ? sidebarContentEl.scrollTop : 0;
    const tabOpts = { tabSwitch: true, carryScroll };
    if (mode === 'fav') {
        // 收藏：若上次在收藏里打开了某目录则恢复它，否则显示收藏清单
        if (favBrowseDir !== null) renderDirectory(favBrowseDir, tabOpts);
        else renderFavList(tabOpts);
    } else if (lastRenderedDir !== null) {
        renderDirectory(lastRenderedDir, tabOpts);   // 全部：还原全部标签的目录
    }
}

(function initDirFilter() {
    document.querySelectorAll('#dir-filter .dir-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => setDirFilter(btn.dataset.filter));
    });
})();

// 启动：恢复上次目录（默认盘符列表），图片区保持“还未选择任何图片”
// pywebview 的 js_api 在页面加载后才注入，必须等待 pywebviewready 事件
function initSidebar() {
    // 恢复上次关闭时所处的标签（全部/收藏）；默认「全部」。
    let savedMode = 'all';
    try { savedMode = localStorage.getItem(DIR_MODE_KEY) === 'fav' ? 'fav' : 'all'; } catch (e) { /* 忽略 */ }
    if (savedMode === 'fav') {
        dirFilterMode = 'fav';
        // 预备「全部」标签的还原目标：启动即进收藏时 lastRenderedDir 仍为初始 null，会让「全部」按钮
        // 因 `else if (lastRenderedDir !== null)` 不成立而无反应；这里从持久化的上次目录补上，保证切回可用。
        try { lastRenderedDir = localStorage.getItem(STORAGE_KEY) ?? DRIVE_ROOT; } catch (e) { lastRenderedDir = DRIVE_ROOT; }
        document.querySelectorAll('#dir-filter .dir-filter-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.filter === 'fav');
        });
        renderFavList();          // 显示收藏清单（favBrowseDir 不持久化，启动回到清单本身）
        return;
    }
    let initialDir = DRIVE_ROOT;
    try { initialDir = localStorage.getItem(STORAGE_KEY) ?? DRIVE_ROOT; } catch (e) { /* 忽略 */ }
    renderDirectory(initialDir);
}

if (window.pywebview) {
    // 已就绪（页面加载较慢时可能已注入）
    initSidebar();
} else {
    window.addEventListener('pywebviewready', initSidebar, { once: true });
}

// ===== 侧栏默认宽度：按缩略图盒子宽 × 列数算“刚好容纳 N 列” =====
// 公式：默认宽 = thumb-w × 列数 + (列数-3)×gap + 62。其中 62 = 左右 padding + 2 条列间距 + 纵向滚动条 + 少量余量（列数=3 时与旧版逐像素一致）。
// 列数取 window.sidebarColCount（main.js 启动恢复 + 点「保存」更新），取不到回退 3。
// 算完写回内联 --sidebar-width；CSS :root 里的 --sidebar-width 仅作取不到 thumb-w 时的回退值。
// 全局函数：启动调一次；main.js 切换缩略图尺寸档 / 列数（点「保存」）后也调它，让侧栏宽度实时跟随重算。
function refitSidebarWidth() {
    const thumbW = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--thumb-w'));
    if (isNaN(thumbW)) return;                        // 取不到就沿用 CSS :root 里的回退值
    const cols = (window.sidebarColCount | 0) || 3;   // 生效列数（1~8），取不到回退 3
    const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--thumb-gap')) || 3;
    const width = thumbW * cols + (cols - 3) * gap + 62;   // cols=3 时退化为旧公式 thumbW*3 + 62
    // 窗口模式：阈值上限取 app 宽的 50%（与拖拽同基准）；算出的默认宽超阈则夹到阈值，否则用计算值
    const maxW = document.getElementById('app').clientWidth * 0.5;
    document.documentElement.style.setProperty('--sidebar-width', `${Math.min(width, maxW)}px`);
}
refitSidebarWidth();   // 启动算一次（main.js 已先行把 --thumb-w 恢复为持久化档位）

// ===== 侧栏宽度可拖拽调节 =====
// 只改写根上的 --sidebar-width（工具栏/页码/悬浮滚动条/图片区都引用它，会自动跟随）。
// 故意不写 localStorage：刷新（=重启）后回到默认宽度（启动时按 thumb-w × 3 + 76 算出，见上方 initSidebarDefaultWidth）。
(function initSidebarResizer() {
    const resizer = document.getElementById('sidebar-resizer');
    const sidebar = document.getElementById('sidebar');
    const appEl = document.getElementById('app');
    if (!resizer) return;

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    // 侧栏最小宽度：thumb-w + 55（盒子宽 + padding38 + 进度条16 + 1px 微调），按当前 --thumb-w 实时取值；取不到则回退 175
    const sidebarMinWidth = () => {
        const tw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--thumb-w'));
        return isNaN(tw) ? 175 : tw + 55;   // 上限仍为 app 宽的 50%（拖拽 / 缩窄夹取都用这个下限）
    };
    let dragging = false;

    resizer.addEventListener('mousedown', (e) => {
        if (sidebar.classList.contains('collapsed')) return; // 收起态不可调
        dragging = true;
        appEl.classList.add('resizing');                    // 关闭过渡，拖动跟手
        document.body.style.userSelect = 'none';            // 防拖动时选中文字/图片
        e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const appW = appEl.clientWidth;
        // 侧栏靠右：宽 = 视口右缘到鼠标当前 X 的距离；钳到 [170px, app 宽×0.5]
        const w = clamp(window.innerWidth - e.clientX, sidebarMinWidth(), appW * 0.5);
        document.documentElement.style.setProperty('--sidebar-width', w + 'px');
    });

    window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        appEl.classList.remove('resizing');
        document.body.style.userSelect = '';
    });

    // 窗口缩放时重新钳位侧栏宽度，避免超出 [170px, 50%] 范围后拖动时跳变
    window.addEventListener('resize', () => {
        if (sidebar.classList.contains('collapsed')) return;
        const appW = appEl.clientWidth;
        const raw = getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width');
        const currentW = parseFloat(raw);
        if (isNaN(currentW)) return; // 取不到数值则不处理（--sidebar-width 始终为普通 px，parseFloat 可解析）
        const clamped = clamp(currentW, sidebarMinWidth(), appW * 0.5);
        if (clamped !== currentW) {
            document.documentElement.style.setProperty('--sidebar-width', clamped + 'px');
        }
    });
})();

// ===== 侧栏“回到顶部” =====
// 侧栏内容（目录列表 + 缩略图网格）的滚动容器是 #sidebar-content；
// 图片很多时手动拖回顶部累，点此按钮平滑滚回顶部。侧栏收起时按钮已被 CSS 隐藏。
(function initBackToTop() {
    const btn = document.getElementById('back-to-top');
    const content = document.getElementById('sidebar-content');
    if (!btn || !content) return;
    btn.addEventListener('click', () => {
        content.scrollTo({ top: 0, behavior: 'smooth' });
    });
})();

// ===== 收藏清单「排序方向」切换（仅收藏清单出现）=====
// 点击在升序(先收藏在前)/降序(后收藏在前，默认)间切换；方向持久化到 localStorage，重启不丢。
(function initFavSort() {
    if (!favSortBtn) return;
    const paint = () => favSortBtn.classList.toggle('fav-sort-desc', favSortDesc);   // 按方向切图标
    paint();                                        // 启动先渲染当前方向图标
    favSortBtn.addEventListener('click', () => {
        favSortDesc = !favSortDesc;
        saveFavSortDesc(favSortDesc);
        paint();
        if (viewingFavList) renderFavList();         // 正展示收藏清单 → 立即按新方向重排（captureScroll 会保住滚动位置）
    });
})();
