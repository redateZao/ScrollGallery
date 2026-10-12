// ===== 真实后端 API 桥接 =====
// 通过 pywebview js_api 调用 Python 后端。
// 保留 MockAPI 变量名，main.js / sidebar.js 调用代码无需修改。

const MockAPI = {
    /**
     * 列出目录中的图片详情（主预览区用）。
     * 返回 [{ name, url, width, height, thumb_url }]（按文件名排序）。
     */
    async listImages(dirPath) {
        return await window.pywebview.api.list_images(dirPath);
    },

    /**
     * 列出目录信息（侧栏导航用）。
     * dirPath 传 '' 表示根级（盘符列表）。
     * 返回 { path, parent, dirs, images: [{name, thumb_url}] }
     */
    async listDirectory(dirPath) {
        return await window.pywebview.api.list_directory(dirPath);
    },
};
