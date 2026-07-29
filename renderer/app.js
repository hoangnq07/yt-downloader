/**
 * app.js — Renderer Process Logic
 * YouTube Downloader Pro
 */

document.addEventListener('DOMContentLoaded', async () => {

  // ═══ Element References ═══

  const urlInput = document.getElementById('urlInput');
  const btnPaste = document.getElementById('btnPaste');
  const btnClear = document.getElementById('btnClear');
  const urlLoading = document.getElementById('urlLoading');
  const urlHint = document.getElementById('urlHint');

  const infoCard = document.getElementById('infoCard');
  const infoThumb = document.getElementById('infoThumb');
  const infoDuration = document.getElementById('infoDuration');
  const infoTitle = document.getElementById('infoTitle');
  const infoChannelName = document.getElementById('infoChannelName');
  const infoViewCount = document.getElementById('infoViewCount');

  const downloadPanel = document.getElementById('downloadPanel');
  const tabs = document.querySelectorAll('.tab');
  const tabContents = document.querySelectorAll('.tab-content');

  const subtitleList = document.getElementById('subtitleList');
  const thumbPreviewImg = document.getElementById('thumbPreviewImg');
  const thumbDimBadge = document.getElementById('thumbDimBadge');
  const thumbFallbackNotice = document.getElementById('thumbFallbackNotice');

  const folderPath = document.getElementById('folderPath');
  const btnFolder = document.getElementById('btnFolder');
  const btnDownload = document.getElementById('btnDownload');
  const btnCancel = document.getElementById('btnCancel');

  const progressSection = document.getElementById('progressSection');
  const progressLabel = document.getElementById('progressLabel');
  const progressPercent = document.getElementById('progressPercent');
  const progressBar = document.getElementById('progressBar');
  const progressSpeed = document.getElementById('progressSpeed');
  const progressSize = document.getElementById('progressSize');
  const progressETA = document.getElementById('progressETA');

  const doneSection = document.getElementById('doneSection');
  const btnCloseDone = document.getElementById('btnCloseDone');
  const doneFileName = document.getElementById('doneFileName');
  const btnOpenFile = document.getElementById('btnOpenFile');
  const btnOpenFolder = document.getElementById('btnOpenFolder');
  const btnCopyPath = document.getElementById('btnCopyPath');
  const btnNewDownload = document.getElementById('btnNewDownload');
  const chkAutoOpenFolder = document.getElementById('chkAutoOpenFolder');

  const setupOverlay = document.getElementById('setupOverlay');
  const setupMessage = document.getElementById('setupMessage');
  const setupProgressBar = document.getElementById('setupProgressBar');
  const setupSub = document.getElementById('setupSub');

  const toast = document.getElementById('toast');
  const toastMessage = document.getElementById('toastMessage');

  const btnSettingsToggle = document.getElementById('btnSettingsToggle');
  const settingsModalOverlay = document.getElementById('settingsModalOverlay');
  const btnCloseSettings = document.getElementById('btnCloseSettings');
  const themeCards = document.querySelectorAll('.theme-card');

  const navBtnDownloader = document.getElementById('navBtnDownloader');
  const navBtnManager = document.getElementById('navBtnManager');
  const viewDownloader = document.getElementById('viewDownloader');
  const viewManager = document.getElementById('viewManager');
  const navQueueBadge = document.getElementById('navQueueBadge');
  const subBtnActiveQueue = document.getElementById('subBtnActiveQueue');
  const subBtnCompletedHistory = document.getElementById('subBtnCompletedHistory');
  const subContentActiveQueue = document.getElementById('subContentActiveQueue');
  const subContentCompletedHistory = document.getElementById('subContentCompletedHistory');
  const activeQueueBadge = document.getElementById('activeQueueBadge');
  const activeQueueList = document.getElementById('activeQueueList');
  const managerHistoryList = document.getElementById('managerHistoryList');
  const btnClearHistoryManager = document.getElementById('btnClearHistoryManager');

  const playlistCard = document.getElementById('playlistCard');
  const playlistTitle = document.getElementById('playlistTitle');
  const playlistCountBadge = document.getElementById('playlistCountBadge');
  const playlistItemsList = document.getElementById('playlistItemsList');
  const chkSelectAllPlaylist = document.getElementById('chkSelectAllPlaylist');

  const btnToggleSubtasks = document.getElementById('btnToggleSubtasks');
  const subtaskList = document.getElementById('subtaskList');
  const subtaskCountBadge = document.getElementById('subtaskCountBadge');

  btnToggleSubtasks?.addEventListener('click', () => {
    btnToggleSubtasks.classList.toggle('expanded');
    subtaskList?.classList.toggle('hidden');
  });

  let currentSubtasks = [];

  function renderSubtasks() {
    if (!subtaskList) return;
    subtaskList.innerHTML = '';
    const completedCount = currentSubtasks.filter(s => s.status === 'done').length;
    if (subtaskCountBadge) {
      subtaskCountBadge.textContent = `${completedCount}/${currentSubtasks.length}`;
    }

    currentSubtasks.forEach(st => {
      const div = document.createElement('div');
      div.className = `subtask-item ${st.status}`;
      const name = document.createElement('span');
      name.textContent = st.name || '';
      const status = document.createElement('span');
      status.className = 'subtask-status';
      status.textContent = st.statusText || 'Chờ...';
      div.append(name, status);
      subtaskList.appendChild(div);
    });
  }

  // ═══ Settings Modal, Theme & Language Switcher ═══

  const langCards = document.querySelectorAll('.lang-card');

  const translations = {
    vi: {
      settingsTitle: 'Cài đặt ứng dụng',
      historyTitle: 'Lịch sử tải xuống',
      settingsBtn: 'Cài đặt',
      historyBtn: 'Lịch sử tải xuống',
      navDownloader: 'Tải xuống',
      navManager: 'Quản lý & lịch sử',
      queueTab: 'Đang tải & hàng đợi',
      historyTab: 'Đã hoàn tất',
      clearHistory: 'Xóa lịch sử',
      langLabel: 'Ngôn ngữ ứng dụng',
      themeLabel: 'Màu giao diện chủ đạo',
      urlPlaceholder: 'Dán link YouTube vào đây...',
      urlHint: 'Hỗ trợ youtube.com, youtu.be, shorts, live, playlist',
      tabVideo: 'Video',
      tabAudio: 'Audio',
      tabSubtitle: 'Phụ đề',
      tabThumbnail: 'Thumbnail',
      tabMetadata: 'Metadata',
      tabBundle: 'Tải tất cả',
      downloadBtn: 'Thêm vào hàng đợi',
      cancelBtn: 'Hủy',
      subtasksLabel: 'Chi tiết',
      doneTitle: 'Tải xuống hoàn tất!',
      openFile: 'Mở file',
      openFolder: 'Mở thư mục',
    },
    en: {
      settingsTitle: 'Settings',
      historyTitle: 'Download History',
      settingsBtn: 'Settings',
      historyBtn: 'History',
      navDownloader: 'Downloader',
      navManager: 'Downloads & history',
      queueTab: 'Active & queued',
      historyTab: 'Completed',
      clearHistory: 'Clear history',
      langLabel: 'App Language',
      themeLabel: 'Accent Theme',
      urlPlaceholder: 'Paste YouTube link here...',
      urlHint: 'Supports youtube.com, youtu.be, shorts, live, playlists',
      tabVideo: 'Video',
      tabAudio: 'Audio',
      tabSubtitle: 'Subtitles',
      tabThumbnail: 'Thumbnail',
      tabMetadata: 'Metadata',
      tabBundle: 'Download All',
      downloadBtn: 'Add to queue',
      cancelBtn: 'Cancel',
      subtasksLabel: 'Details',
      doneTitle: 'Download Complete!',
      openFile: 'Open File',
      openFolder: 'Open Folder',
    }
  };

  function applyLanguage(lang) {
    const t = translations[lang] || translations.vi;
    document.documentElement.lang = lang === 'en' ? 'en' : 'vi';

    langCards.forEach(card => {
      card.classList.toggle('active', card.dataset.lang === lang);
    });

    if (urlInput) urlInput.placeholder = t.urlPlaceholder;
    if (urlHint) urlHint.textContent = t.urlHint;

    const btnSettingsText = document.querySelector('#btnSettingsToggle span');
    if (btnSettingsText) btnSettingsText.textContent = t.settingsBtn;
    const settingsTitleText = document.querySelector('.modal-title span');
    if (settingsTitleText) settingsTitleText.textContent = t.settingsTitle;
    const langLabelText = document.querySelector('[data-i18n="langLabel"]');
    if (langLabelText) langLabelText.textContent = t.langLabel;
    const themeLabelText = document.querySelector('[data-i18n="themeLabel"]');
    if (themeLabelText) themeLabelText.textContent = t.themeLabel;

    const navDownloaderText = document.querySelector('#navBtnDownloader span');
    if (navDownloaderText) navDownloaderText.textContent = t.navDownloader;
    const navManagerText = document.querySelector('#navBtnManager > span:not(.nav-queue-badge)');
    if (navManagerText) navManagerText.textContent = t.navManager;
    const queueTabText = document.querySelector('#subBtnActiveQueue > span:not(.subnav-badge)');
    if (queueTabText) queueTabText.textContent = t.queueTab;
    const historyTabText = document.querySelector('#subBtnCompletedHistory span');
    if (historyTabText) historyTabText.textContent = t.historyTab;
    if (btnClearHistoryManager) btnClearHistoryManager.textContent = t.clearHistory;

    const tabVideoSpan = document.querySelector('#tabVideo span');
    if (tabVideoSpan) tabVideoSpan.textContent = t.tabVideo;

    const tabAudioSpan = document.querySelector('#tabAudio span');
    if (tabAudioSpan) tabAudioSpan.textContent = t.tabAudio;

    const tabSubSpan = document.querySelector('#tabSubtitle span');
    if (tabSubSpan) tabSubSpan.textContent = t.tabSubtitle;

    const tabThumbSpan = document.querySelector('#tabThumbnail span');
    if (tabThumbSpan) tabThumbSpan.textContent = t.tabThumbnail;

    const tabMetadataSpan = document.querySelector('#tabMetadata span');
    if (tabMetadataSpan) tabMetadataSpan.textContent = t.tabMetadata;

    const tabBundleSpan = document.querySelector('#tabBundle span');
    if (tabBundleSpan) tabBundleSpan.textContent = t.tabBundle;

    const btnDownloadSpan = document.querySelector('#btnDownload span');
    if (btnDownloadSpan) btnDownloadSpan.textContent = t.downloadBtn;

    const btnCancelSpan = document.querySelector('#btnCancel span');
    if (btnCancelSpan) btnCancelSpan.textContent = t.cancelBtn;

    const btnToggleSubtasksSpan = document.querySelector('#btnToggleSubtasks span');
    if (btnToggleSubtasksSpan) btnToggleSubtasksSpan.textContent = t.subtasksLabel;

    const doneTitleEl = document.querySelector('.done-title');
    if (doneTitleEl) doneTitleEl.textContent = t.doneTitle;
  }

  langCards.forEach(card => {
    card.addEventListener('click', async () => {
      const selectedLang = card.dataset.lang;
      applyLanguage(selectedLang);
      currentSettings.language = selectedLang;
      await persistSettings();
      showToast(selectedLang === 'en' ? 'Language switched to English!' : 'Đã đổi sang Tiếng Việt!', 'success');
    });
  });

  btnSettingsToggle?.addEventListener('click', () => {
    settingsModalOverlay?.classList.remove('hidden');
  });

  btnCloseSettings?.addEventListener('click', () => {
    settingsModalOverlay?.classList.add('hidden');
  });

  settingsModalOverlay?.addEventListener('click', (e) => {
    if (e.target === settingsModalOverlay) {
      settingsModalOverlay.classList.add('hidden');
    }
  });

  function applyTheme(theme) {
    document.body.dataset.theme = theme;
    themeCards.forEach(card => {
      card.classList.toggle('active', card.dataset.theme === theme);
    });
  }

  themeCards.forEach(card => {
    card.addEventListener('click', async () => {
      const themeName = card.dataset.theme;
      applyTheme(themeName);
      currentSettings.theme = themeName;
      await persistSettings();
      const name = card.querySelector('.theme-name')?.textContent || themeName;
      showToast(`Đã đổi màu giao diện sang ${name}!`, 'success');
    });
  });

  // ═══ Main Navigation & Download Manager ═══

  function setMainView(viewName) {
    const showManager = viewName === 'manager';
    navBtnDownloader?.classList.toggle('active', !showManager);
    navBtnManager?.classList.toggle('active', showManager);
    navBtnDownloader?.setAttribute('aria-selected', String(!showManager));
    navBtnManager?.setAttribute('aria-selected', String(showManager));
    viewDownloader?.classList.toggle('active', !showManager);
    viewManager?.classList.toggle('active', showManager);
    if (showManager) {
      renderActiveQueue();
      renderCompletedHistory();
    }
  }

  function setManagerSection(sectionName) {
    const showHistory = sectionName === 'history';
    subBtnActiveQueue?.classList.toggle('active', !showHistory);
    subBtnCompletedHistory?.classList.toggle('active', showHistory);
    subBtnActiveQueue?.setAttribute('aria-selected', String(!showHistory));
    subBtnCompletedHistory?.setAttribute('aria-selected', String(showHistory));
    subContentActiveQueue?.classList.toggle('active', !showHistory);
    subContentCompletedHistory?.classList.toggle('active', showHistory);
    if (showHistory) renderCompletedHistory();
    else renderActiveQueue();
  }

  navBtnDownloader?.addEventListener('click', () => setMainView('downloader'));
  navBtnManager?.addEventListener('click', () => setMainView('manager'));
  subBtnActiveQueue?.addEventListener('click', () => setManagerSection('queue'));
  subBtnCompletedHistory?.addEventListener('click', () => setManagerSection('history'));

  function makeTaskThumbnail(source, altText = '') {
    const image = document.createElement('img');
    image.className = 'task-thumb';
    image.alt = altText;
    image.src = source || 'icon.png';
    image.addEventListener('error', () => {
      if (!image.src.endsWith('/icon.png') && !image.src.endsWith('\\icon.png')) {
        image.src = 'icon.png';
      }
    }, { once: true });
    return image;
  }

  function makeTaskButton(label, className, handler, title = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.title = title || label;
    button.addEventListener('click', handler);
    return button;
  }

  function updateQueueBadges() {
    const count = activeTasksMap.size + pendingTasks.length;
    if (navQueueBadge) {
      navQueueBadge.textContent = String(count);
      navQueueBadge.classList.toggle('hidden', count === 0);
    }
    if (activeQueueBadge) activeQueueBadge.textContent = String(count);
  }

  function appendTaskInfo(card, task, isPending = false) {
    const info = document.createElement('div');
    info.className = 'task-info-group';

    const title = document.createElement('div');
    title.className = 'task-title';
    title.textContent = task.title || 'Video YouTube';
    title.title = title.textContent;

    const meta = document.createElement('div');
    meta.className = 'task-meta-row';
    const type = document.createElement('span');
    const typeText = String(task.type || 'video').toUpperCase();
    const formatText = String(task.format || '').toUpperCase();
    type.textContent = `${typeText}${formatText ? ` (${formatText})` : ''} • ${isPending ? 'Đang chờ' : (task.speed || '--')}`;
    const progress = document.createElement('span');
    const percent = Math.max(0, Math.min(Number(task.percent) || 0, 100));
    progress.textContent = isPending ? 'Trong hàng đợi' : `${percent.toFixed(1)}% • ${task.eta || 'ETA: --'}`;
    meta.append(type, progress);

    const track = document.createElement('div');
    track.className = 'task-progress-track';
    const fill = document.createElement('div');
    fill.className = 'task-progress-fill';
    fill.style.width = `${isPending ? 0 : percent}%`;
    track.appendChild(fill);
    info.append(title, meta, track);
    card.appendChild(info);
  }

  function renderActiveQueue() {
    if (!activeQueueList) return;
    activeQueueList.replaceChildren();
    const runningTasks = Array.from(activeTasksMap.values());

    if (pendingTasks.length === 0 && runningTasks.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'queue-empty';
      empty.textContent = 'Chưa có tác vụ tải nào';
      activeQueueList.appendChild(empty);
      return;
    }

    pendingTasks.forEach(pending => {
      const card = document.createElement('article');
      card.className = 'task-card pending';
      card.appendChild(makeTaskThumbnail(pending.opts.thumbnail, pending.opts.title));
      appendTaskInfo(card, pending.opts, true);
      card.appendChild(makeTaskButton('Bỏ hàng đợi', 'task-cancel-btn', () => {
        const index = pendingTasks.findIndex(item => item.localId === pending.localId);
        if (index >= 0) pendingTasks.splice(index, 1);
        updateQueueBadges();
        renderActiveQueue();
        renderInlineQueueSummary();
      }));
      activeQueueList.appendChild(card);
    });

    runningTasks.forEach(task => {
      const card = document.createElement('article');
      card.className = 'task-card';
      card.appendChild(makeTaskThumbnail(task.thumbnail, task.title));
      appendTaskInfo(card, task);
      card.appendChild(makeTaskButton('Hủy', 'task-cancel-btn', async () => {
        try {
          await window.ytdlp.cancelDownloadTask(task.id);
        } catch (error) {
          showToast(`Không thể hủy: ${error.message || error}`, 'error');
        }
      }));
      activeQueueList.appendChild(card);
    });
  }

  async function renderCompletedHistory() {
    if (!managerHistoryList) return;

    try {
      const history = await window.ytdlp.getHistory();
      managerHistoryList.replaceChildren();
      if (!Array.isArray(history) || history.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'history-empty';
        empty.textContent = 'Chưa có lịch sử tải xuống nào';
        managerHistoryList.appendChild(empty);
        return;
      }

      history.forEach((item) => {
        const card = document.createElement('article');
        card.className = 'task-card';
        card.appendChild(makeTaskThumbnail(item.thumbnail, item.title));

        const info = document.createElement('div');
        info.className = 'task-info-group';
        const title = document.createElement('div');
        title.className = 'task-title';
        title.textContent = item.title || item.fileName || 'Tệp đã tải';
        title.title = title.textContent;
        const meta = document.createElement('div');
        meta.className = 'task-meta-row';
        const detail = document.createElement('span');
        detail.textContent = `${item.channel || 'YouTube'}${item.format ? ` • ${String(item.format).toUpperCase()}` : ''} • ${item.date || ''}`;
        const status = document.createElement('span');
        status.className = 'task-status-success';
        status.textContent = 'Hoàn tất';
        meta.append(detail, status);
        info.append(title, meta);
        card.appendChild(info);

        const actions = document.createElement('div');
        actions.className = 'task-actions';
        const filePathValue = item.filePath || '';
        actions.append(
          makeTaskButton('Mở file', 'task-action-btn', () => filePathValue && window.ytdlp.openFile(filePathValue)),
          makeTaskButton('Mở thư mục', 'task-action-btn', () => window.ytdlp.openFolder(item.folderPath || filePathValue || currentOutputDir)),
          makeTaskButton('Sao chép', 'task-action-btn', async () => {
            if (!filePathValue) return;
            try {
              await navigator.clipboard.writeText(filePathValue);
              showToast('Đã sao chép đường dẫn file!', 'success');
            } catch {
              showToast('Không thể sao chép đường dẫn file.', 'error');
            }
          }),
          makeTaskButton('Xóa', 'task-action-btn', async () => {
            try {
              await window.ytdlp.removeHistoryItem(item.id);
              await renderCompletedHistory();
            } catch (error) {
              showToast(`Không thể xóa mục lịch sử: ${error.message || error}`, 'error');
            }
          })
        );
        card.appendChild(actions);
        managerHistoryList.appendChild(card);
      });
    } catch (error) {
      managerHistoryList.replaceChildren();
      const message = document.createElement('p');
      message.className = 'history-empty';
      message.textContent = `Không thể đọc lịch sử: ${error.message || error}`;
      managerHistoryList.appendChild(message);
    }
  }

  btnClearHistoryManager?.addEventListener('click', async () => {
    try {
      await window.ytdlp.clearHistory();
      await renderCompletedHistory();
      showToast('Đã xóa toàn bộ lịch sử!', 'success');
    } catch (error) {
      showToast(`Không thể xóa lịch sử: ${error.message || error}`, 'error');
    }
  });

  // ═══ State ═══

  let videoInfo = null;
  let currentTab = 'video';
  let currentOutputDir = '';
  let lastDownloadedFile = '';
  let lastDownloadedFolder = '';
  let debounceTimer = null;
  let infoRequestGeneration = 0;
  let focusedTaskId = '';
  let queuePumpRunning = false;
  let pendingSequence = 0;
  let queueHadCompletion = false;
  let queueCompletionShown = false;
  let autoOpenTimer = null;
  const MAX_CONCURRENT_TASKS = 3;
  const activeTasksMap = new Map();
  const pendingTasks = [];
  let currentSettings = {
    language: 'vi',
    theme: 'red',
    downloadPath: '',
    autoOpenFolder: false,
  };

  // Chip state per tab
  const selections = {
    video: { quality: 'best', format: 'mp4' },
    audio: { quality: 'best', format: 'mp3' },
    subtitle: { lang: '', format: 'srt' },
    thumbnail: { quality: 'maxresdefault', format: 'jpg' },
    metadata: { quality: '', format: 'txt' },
  };

  async function persistSettings() {
    currentSettings.downloadPath = currentOutputDir || currentSettings.downloadPath || '';
    try {
      await window.ytdlp.saveSettings({ ...currentSettings });
    } catch (error) {
      console.error('Không thể lưu cài đặt:', error);
    }
  }

  async function loadPersistentSettings() {
    try {
      const saved = await window.ytdlp.getSettings();
      if (saved && typeof saved === 'object') {
        currentSettings = { ...currentSettings, ...saved };
      }
    } catch (error) {
      console.error('Không thể đọc cài đặt:', error);
    }

    currentOutputDir = currentSettings.downloadPath || '';
    applyTheme(currentSettings.theme || 'red');
    applyLanguage(currentSettings.language || 'vi');
    if (chkAutoOpenFolder) chkAutoOpenFolder.checked = Boolean(currentSettings.autoOpenFolder);
    if (currentOutputDir) updateFolderDisplay();
  }

  // ═══ Window Controls ═══

  document.getElementById('btnMinimize').addEventListener('click', () => window.ytdlp.windowMinimize());
  document.getElementById('btnMaximize').addEventListener('click', () => window.ytdlp.windowMaximize());
  document.getElementById('btnClose').addEventListener('click', () => window.ytdlp.windowClose());

  // ═══ Setup Check ═══

  async function checkAndSetup() {
    const ready = await window.ytdlp.checkBinaries();
    if (!ready) {
      setupOverlay.classList.remove('hidden');

      const cleanupListener = window.ytdlp.onSetupStatus((status) => {
        setupMessage.textContent = status.message || '';
        if (status.percent) {
          setupProgressBar.style.width = `${status.percent}%`;
        }
        if (status.status === 'extracting') {
          setupSub.textContent = 'Đang giải nén...';
          setupProgressBar.style.width = '100%';
        }
      });

      const result = await window.ytdlp.setupBinaries();
      cleanupListener();

      if (result.success) {
        setupOverlay.classList.add('hidden');
      } else {
        setupMessage.textContent = 'Lỗi: ' + (result.error || 'Không thể tải công cụ');
        setupSub.textContent = 'Vui lòng kiểm tra kết nối mạng và thử lại.';
        return false;
      }
    }

    // Use the persisted path when available, otherwise initialise the default.
    if (!currentOutputDir) {
      currentOutputDir = await window.ytdlp.getDownloadPath();
      currentSettings.downloadPath = currentOutputDir;
      await persistSettings();
    }
    updateFolderDisplay();
    return true;
  }

  // ═══ Helpers ═══

  function formatViews(n) {
    if (!n) return '0';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + ' tỷ';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + ' triệu';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + ' nghìn';
    return n.toLocaleString('vi-VN');
  }

  function showToast(message, type = 'info') {
    const icon = toast.querySelector('.toast-icon');
    icon.className = 'toast-icon' + (type === 'success' ? ' success' : type === 'error' ? ' error' : '');
    toastMessage.textContent = message;
    toast.classList.remove('hidden');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.add('hidden'), 3500);
  }

  function setHint(text, type = '') {
    urlHint.textContent = text;
    urlHint.className = 'url-hint' + (type ? ' ' + type : '');
  }

  function updateFolderDisplay() {
    const displayPath = currentOutputDir
      .replace(/\\/g, '/')
      .replace(/^[A-Z]:\/Users\/[^/]+/, '~');
    folderPath.textContent = displayPath;
  }

  // ═══ Chip Group Logic ═══

  function updateThumbnailPreview(isFallbackAttempt = false) {
    if (!videoInfo || !videoInfo.id) return;
    const quality = selections.thumbnail.quality || 'maxresdefault';
    const targetUrl = `https://img.youtube.com/vi/${videoInfo.id}/${quality}.jpg`;

    const tempImg = new Image();
    tempImg.crossOrigin = 'Anonymous';
    tempImg.onload = () => {
      const width = tempImg.naturalWidth;
      const height = tempImg.naturalHeight;

      if (quality === 'maxresdefault' && width <= 120 && height <= 90 && !isFallbackAttempt) {
        if (thumbFallbackNotice) thumbFallbackNotice.classList.remove('hidden');
        const hqChip = document.querySelector('#thumbQualityChips .chip[data-value="hqdefault"]');
        if (hqChip) {
          document.querySelectorAll('#thumbQualityChips .chip').forEach(c => c.classList.remove('active'));
          hqChip.classList.add('active');
          selections.thumbnail.quality = 'hqdefault';
        }
        updateThumbnailPreview(true);
        return;
      }

      if (!isFallbackAttempt && thumbFallbackNotice) {
        thumbFallbackNotice.classList.add('hidden');
      }

      if (thumbPreviewImg) thumbPreviewImg.src = targetUrl;
      if (thumbDimBadge) thumbDimBadge.textContent = `${width} × ${height}`;
    };

    tempImg.onerror = () => {
      if (quality === 'maxresdefault' && !isFallbackAttempt) {
        if (thumbFallbackNotice) thumbFallbackNotice.classList.remove('hidden');
        const hqChip = document.querySelector('#thumbQualityChips .chip[data-value="hqdefault"]');
        document.querySelectorAll('#thumbQualityChips .chip').forEach(c => c.classList.remove('active'));
        hqChip?.classList.add('active');
        selections.thumbnail.quality = 'hqdefault';
        updateThumbnailPreview(true);
      }
    };

    tempImg.src = targetUrl;
  }

  function initChipGroups() {
    document.querySelectorAll('.chip-group').forEach(group => {
      group.addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (!chip || chip.classList.contains('unavailable')) return;

        // Deactivate siblings
        group.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');

        // Update selection state
        const groupId = group.id;
        const value = chip.dataset.value;

        if (groupId === 'videoQualityChips') selections.video.quality = value;
        else if (groupId === 'videoFormatChips') selections.video.format = value;
        else if (groupId === 'audioQualityChips') selections.audio.quality = value;
        else if (groupId === 'audioFormatChips') selections.audio.format = value;
        else if (groupId === 'subtitleFormatChips') selections.subtitle.format = value;
        else if (groupId === 'thumbQualityChips') {
          selections.thumbnail.quality = value;
          updateThumbnailPreview();
        }
        else if (groupId === 'thumbFormatChips') selections.thumbnail.format = value;
        else if (groupId === 'metadataFormatChips') selections.metadata.format = value;
      });
    });
  }

  // ═══ Tab Switching ═══

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      if (target === currentTab) return;
      currentTab = target;

      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      tabContents.forEach(tc => {
        tc.classList.toggle('active', tc.dataset.content === target);
      });
    });
  });

  // ═══ URL Input ═══

  urlInput.addEventListener('input', () => {
    const val = urlInput.value.trim();
    btnClear.classList.toggle('hidden', !val);
    btnPaste.classList.toggle('hidden', !!val);

    clearTimeout(debounceTimer);
    if (val) {
      debounceTimer = setTimeout(() => fetchVideoInfo(val), 600);
    } else {
      resetVideoState();
    }
  });

  btnPaste.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        urlInput.value = text.trim();
        btnClear.classList.remove('hidden');
        btnPaste.classList.add('hidden');
        fetchVideoInfo(text.trim());
      }
    } catch {
      showToast('Không thể đọc clipboard', 'error');
    }
  });

  btnClear.addEventListener('click', () => {
    urlInput.value = '';
    btnClear.classList.add('hidden');
    btnPaste.classList.remove('hidden');
    resetVideoState();
    urlInput.focus();
  });

  function cleanSingleVideoUrl(rawUrl) {
    if (rawUrl.includes('watch?v=')) {
      return rawUrl.split('&list=')[0].split('&index=')[0];
    }
    return rawUrl;
  }

  function formatDuration(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const secs = Math.floor(value % 60);
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
      : `${minutes}:${String(secs).padStart(2, '0')}`;
  }

  function normalizeSubtitles(rawSubtitles) {
    if (Array.isArray(rawSubtitles)) {
      return rawSubtitles.map(sub => ({
        code: String(sub.code || sub.lang || ''),
        name: String(sub.name || sub.code || sub.lang || ''),
        formats: Array.isArray(sub.formats) ? sub.formats : [],
      })).filter(sub => sub.code);
    }
    if (!rawSubtitles || typeof rawSubtitles !== 'object') return [];
    return Object.entries(rawSubtitles).map(([code, tracks]) => ({
      code,
      name: String(tracks?.[0]?.name || code),
      formats: Array.isArray(tracks) ? tracks.map(track => track.ext).filter(Boolean) : [],
    }));
  }

  function normalizeVideoInfo(raw, sourceUrl) {
    if (!raw || typeof raw !== 'object') throw new Error('Dữ liệu video không hợp lệ');
    const duration = Number(raw.duration) || 0;
    return {
      ...raw,
      id: String(raw.id || ''),
      sourceUrl: raw.webpage_url || raw.original_url || sourceUrl,
      title: String(raw.title || raw.fulltitle || 'Video YouTube'),
      channel: String(raw.channel || raw.uploader || 'YouTube'),
      duration,
      durationString: raw.durationString || raw.duration_string || formatDuration(duration),
      viewCount: Number(raw.viewCount ?? raw.view_count) || 0,
      thumbnail: String(raw.thumbnail || raw.thumbnails?.at?.(-1)?.url || ''),
      formats: Array.isArray(raw.formats) ? raw.formats : [],
      subtitles: normalizeSubtitles(raw.subtitles),
    };
  }

  function normalizePlaylistEntry(item) {
    const id = String(item?.id || '');
    let entryUrl = String(item?.webpage_url || item?.url || '');
    if (!/^https?:\/\//i.test(entryUrl)) {
      const identifier = id || entryUrl;
      entryUrl = identifier ? `https://www.youtube.com/watch?v=${encodeURIComponent(identifier)}` : '';
    }
    return {
      ...item,
      id,
      url: entryUrl,
      title: String(item?.title || 'Untitled'),
      channel: String(item?.channel || item?.uploader || 'YouTube'),
      thumbnail: String(
        item?.thumbnail
        || item?.thumbnails?.at?.(-1)?.url
        || (id ? `https://img.youtube.com/vi/${id}/hqdefault.jpg` : '')
      ),
    };
  }

  // ═══ Fetch Video Info ═══

  async function fetchVideoInfo(url) {
    if (!url) return;
    const requestGeneration = ++infoRequestGeneration;

    // Basic URL validation
    if (!url.match(/youtu\.?be/i) && !url.match(/^[a-zA-Z0-9_-]{11}$/)) {
      urlLoading.classList.add('hidden');
      setHint('URL không hợp lệ. Hãy paste link YouTube.', 'error');
      return;
    }

    // If it's just an ID, build URL
    if (/^[a-zA-Z0-9_-]{11}$/.test(url)) {
      url = `https://www.youtube.com/watch?v=${url}`;
    }

    urlLoading.classList.remove('hidden');
    setHint('Đang lấy thông tin video...');
    infoCard.classList.add('hidden');
    if (playlistCard) playlistCard.classList.add('hidden');
    downloadPanel.classList.add('hidden');
    doneSection.classList.add('hidden');
    playlistData = null;

    try {
      const isDedicatedPlaylist = url.includes('/playlist?') || (/[?&]list=/.test(url) && !url.includes('watch?v='));

      if (isDedicatedPlaylist) {
        await checkAndLoadPlaylist(url, requestGeneration);
        if (requestGeneration !== infoRequestGeneration) return;
        if (playlistData && playlistData.entries.length > 0) {
          downloadPanel.classList.remove('hidden');
          btnDownload.disabled = false;
          setHint(`Đã tải danh sách Playlist (${playlistData.videoCount} video)!`, 'success');
        } else {
          setHint('Không thể tải Playlist.', 'error');
        }
        return;
      }

      // Single Video Download (Clean URL to avoid scanning mix playlists)
      const cleanUrl = cleanSingleVideoUrl(url);
      const rawInfo = await window.ytdlp.getInfo(cleanUrl);
      if (requestGeneration !== infoRequestGeneration) return;
      videoInfo = normalizeVideoInfo(rawInfo, cleanUrl);

      // Render info card
      infoThumb.src = videoInfo.thumbnail;
      infoThumb.onerror = () => {
        infoThumb.onerror = null;
        infoThumb.src = 'icon.png';
      };
      infoTitle.textContent = videoInfo.title;
      infoChannelName.textContent = videoInfo.channel;
      infoViewCount.textContent = formatViews(videoInfo.viewCount) + ' lượt xem';
      infoDuration.textContent = videoInfo.durationString;

      // Thumbnail preview
      updateThumbnailPreview();

      // Render subtitle list
      renderSubtitles(videoInfo);

      // Mark unavailable qualities & calculate sizes
      markAvailableQualities(videoInfo);

      infoCard.classList.remove('hidden');
      downloadPanel.classList.remove('hidden');
      btnDownload.disabled = false;

      if (url.includes('&list=')) {
        setHint('Đã lấy thông tin Video! (Link chứa Playlist: bạn có thể đổi sang link /playlist để tải cả danh sách)', 'success');
      } else {
        setHint('Sẵn sàng tải!', 'success');
      }

    } catch (err) {
      if (requestGeneration !== infoRequestGeneration) return;
      setHint('Lỗi: ' + (err.message || 'Không thể lấy thông tin'), 'error');
      showToast('Không thể lấy thông tin video', 'error');
    } finally {
      if (requestGeneration === infoRequestGeneration) {
        urlLoading.classList.add('hidden');
      }
    }
  }

  function renderSubtitles(info) {
    subtitleList.innerHTML = '';
    
    // Strictly official human-uploaded subtitles only (ignore auto-captions)
    const officialSubs = (info.subtitles || []).map(s => ({ ...s }));

    // Sort: 'vi' first, 'en' second
    officialSubs.sort((a, b) => {
      if (a.code === 'vi') return -1;
      if (b.code === 'vi') return 1;
      if (a.code === 'en') return -1;
      if (b.code === 'en') return 1;
      return a.code.localeCompare(b.code);
    });

    const bundleChkSubtitle = document.getElementById('bundleChkSubtitle');
    const bundleCardSubtitle = bundleChkSubtitle?.closest('.bundle-card');

    if (officialSubs.length === 0) {
      subtitleList.innerHTML = '<p class="empty-hint">Video này không có phụ đề khả dụng (không có phụ đề chính thức)</p>';
      document.querySelectorAll('#subtitleFormatChips .chip').forEach(c => c.classList.add('unavailable'));
      if (bundleChkSubtitle) {
        bundleChkSubtitle.checked = false;
        bundleChkSubtitle.disabled = true;
      }
      if (bundleCardSubtitle) {
        bundleCardSubtitle.classList.add('disabled');
        bundleCardSubtitle.title = 'Video này không có phụ đề chính thức (chỉ có phụ đề tự động)';
      }
      return;
    }

    // Subtitles are available
    document.querySelectorAll('#subtitleFormatChips .chip').forEach(c => c.classList.remove('unavailable'));
    if (bundleChkSubtitle) {
      bundleChkSubtitle.disabled = false;
    }
    if (bundleCardSubtitle) {
      bundleCardSubtitle.classList.remove('disabled');
      bundleCardSubtitle.title = '';
    }

    officialSubs.forEach((sub, idx) => {
      const btn = document.createElement('button');
      btn.className = `sub-chip ${idx === 0 ? 'active' : ''}`;
      btn.dataset.value = sub.code;
      btn.append(document.createTextNode(`${sub.code.toUpperCase()} `));
      const badge = document.createElement('span');
      badge.className = 'auto-badge official';
      badge.textContent = 'SUB';
      btn.appendChild(badge);
      btn.title = `${sub.name || sub.code} (Phụ đề chính thức)`;

      if (idx === 0) selections.subtitle.lang = sub.code;

      btn.addEventListener('click', () => {
        subtitleList.querySelectorAll('.sub-chip').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        selections.subtitle.lang = sub.code;
      });
      subtitleList.appendChild(btn);
    });
  }

  function markAvailableQualities(info) {
    if (!info || !info.formats) return;

    // 1. Video Quality Check
    const availableHeights = new Set(
      info.formats
        .filter(f => f.height && f.vcodec !== 'none')
        .map(f => f.height)
    );

    let maxVideoHeight = 0;
    availableHeights.forEach(h => { if (h > maxVideoHeight) maxVideoHeight = h; });

    let firstAvailableVideoChip = null;

    document.querySelectorAll('#videoQualityChips .chip').forEach(chip => {
      const val = chip.dataset.value;
      const chipLabels = {
        'best': 'Best',
        '2160': '4K (2160p)',
        '1080': '1080p',
        '720': '720p',
        '480': '480p',
        '360': '360p'
      };
      const label = chipLabels[val] || val;
      chip.textContent = label;

      if (val === 'best') {
        chip.classList.remove('unavailable');
        chip.title = 'Chất lượng tốt nhất khả dụng';
        if (!firstAvailableVideoChip) firstAvailableVideoChip = chip;
        return;
      }

      const numVal = parseInt(val, 10);
      if (!isNaN(numVal)) {
        const isAvailable = availableHeights.has(numVal) || (maxVideoHeight > 0 && numVal <= maxVideoHeight);

        if (isAvailable) {
          chip.classList.remove('unavailable');
          chip.title = `${label} khả dụng cho video này`;
          if (!firstAvailableVideoChip) firstAvailableVideoChip = chip;
        } else {
          chip.classList.add('unavailable');
          chip.title = `Video này không hỗ trợ độ phân giải ${label}`;
          if (chip.classList.contains('active')) {
            chip.classList.remove('active');
          }
        }
      }
    });

    const activeVideoChip = document.querySelector('#videoQualityChips .chip.active');
    if (!activeVideoChip && firstAvailableVideoChip) {
      firstAvailableVideoChip.classList.add('active');
      selections.video.quality = firstAvailableVideoChip.dataset.value;
    }

    // 2. Audio Quality & Formats Check
    const audioFormats = info.formats.filter(f => f.acodec !== 'none');
    const hasAudio = audioFormats.length > 0;

    document.querySelectorAll('#audioQualityChips .chip').forEach(chip => {
      const val = chip.dataset.value;
      const audioLabels = {
        'best': 'Best',
        '0': '320kbps (Chất lượng cao)',
        '2': '192kbps',
        '5': '128kbps'
      };
      chip.textContent = audioLabels[val] || val;

      if (!hasAudio) {
        chip.classList.add('unavailable');
        chip.title = 'Video này không có luồng âm thanh';
      } else {
        chip.classList.remove('unavailable');
        chip.title = 'Sẵn sàng trích xuất Audio';
      }
    });
  }

  // ═══ Playlist Support ═══

  let playlistData = null;

  async function checkAndLoadPlaylist(url, requestGeneration = infoRequestGeneration) {
    try {
      setHint('Đang tải danh sách Playlist...');
      const rawPlaylist = await window.ytdlp.getPlaylistInfo(url);
      if (requestGeneration !== infoRequestGeneration) return false;
      const rawEntries = Array.isArray(rawPlaylist) ? rawPlaylist : rawPlaylist?.entries;
      const entries = Array.isArray(rawEntries)
        ? rawEntries.map(normalizePlaylistEntry).filter(entry => entry.url)
        : [];
      playlistData = {
        title: Array.isArray(rawPlaylist) ? 'YouTube Playlist' : (rawPlaylist?.title || 'YouTube Playlist'),
        videoCount: entries.length,
        entries,
      };
      if (entries.length > 0) {
        renderPlaylist(playlistData);
        return true;
      }
    } catch (e) {
      if (requestGeneration !== infoRequestGeneration) return false;
      console.log('Playlist check error:', e);
    }
    if (requestGeneration !== infoRequestGeneration) return false;
    if (playlistCard) playlistCard.classList.add('hidden');
    playlistData = null;
    return false;
  }

  function renderPlaylist(info) {
    if (!playlistCard) return;
    playlistTitle.textContent = info.title;
    playlistCountBadge.textContent = `${info.videoCount} video`;
    playlistItemsList.innerHTML = '';

    info.entries.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'playlist-item';
      const label = document.createElement('label');
      label.className = 'custom-checkbox';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'chk-playlist-item';
      checkbox.dataset.url = item.url;
      checkbox.dataset.title = item.title;
      checkbox.dataset.channel = item.channel;
      checkbox.dataset.thumbnail = item.thumbnail;
      checkbox.dataset.id = item.id;
      checkbox.checked = true;
      const checkmark = document.createElement('span');
      checkmark.className = 'checkmark';
      label.append(checkbox, checkmark);
      const title = document.createElement('span');
      title.className = 'playlist-item-title';
      title.textContent = `${i + 1}. ${item.title}`;
      row.append(label, title);
      playlistItemsList.appendChild(row);
    });

    playlistCard.classList.remove('hidden');
    if (chkSelectAllPlaylist) chkSelectAllPlaylist.checked = true;
    chkSelectAllPlaylist.onchange = () => {
      playlistItemsList.querySelectorAll('.chk-playlist-item').forEach(chk => {
        chk.checked = chkSelectAllPlaylist.checked;
      });
    };
  }

  function resetVideoState() {
    infoRequestGeneration += 1;
    videoInfo = null;
    playlistData = null;
    urlLoading.classList.add('hidden');
    infoCard.classList.add('hidden');
    if (playlistCard) playlistCard.classList.add('hidden');
    downloadPanel.classList.add('hidden');
    progressSection.classList.add('hidden');
    doneSection.classList.add('hidden');
    btnDownload.disabled = true;
    setHint('Hỗ trợ youtube.com, youtu.be, shorts, live, playlist');
  }

  // ═══ Folder Selection ═══

  btnFolder.addEventListener('click', async () => {
    const selected = await window.ytdlp.selectFolder();
    if (selected) {
      currentOutputDir = selected;
      updateFolderDisplay();
      await persistSettings();
    }
  });

  chkAutoOpenFolder?.addEventListener('change', async () => {
    currentSettings.autoOpenFolder = chkAutoOpenFolder.checked;
    await persistSettings();
  });

  // ═══ Download Action ═══


  // ═══ Non-blocking Concurrent Task Queue ═══

  function getDownloadSources() {
    const checkedItems = playlistItemsList
      ? Array.from(playlistItemsList.querySelectorAll('.chk-playlist-item:checked'))
      : [];

    if (playlistData) {
      return checkedItems.map(checkbox => ({
        url: checkbox.dataset.url,
        title: checkbox.dataset.title || 'Video YouTube',
        channel: checkbox.dataset.channel || 'YouTube',
        thumbnail: checkbox.dataset.thumbnail || '',
        id: checkbox.dataset.id || '',
      }));
    }

    if (!videoInfo) return [];
    return [{
      url: videoInfo.sourceUrl || cleanSingleVideoUrl(urlInput.value.trim()),
      title: videoInfo.title,
      channel: videoInfo.channel,
      thumbnail: videoInfo.thumbnail,
      id: videoInfo.id,
    }];
  }

  function getDownloadComponents() {
    if (currentTab !== 'bundle') {
      const selected = selections[currentTab] || {};
      return [{
        type: currentTab,
        quality: selected.quality || '',
        format: selected.format || (currentTab === 'metadata' ? 'txt' : ''),
        subLang: selections.subtitle.lang || 'vi',
        thumbRes: selections.thumbnail.quality || 'maxresdefault',
        label: currentTab,
      }];
    }

    const components = [];
    if (document.getElementById('bundleChkVideo')?.checked) {
      components.push({
        type: 'video',
        quality: document.getElementById('bundleSelVideoQuality')?.value || 'best',
        format: 'mp4',
        label: 'Video (MP4)',
      });
    }
    if (document.getElementById('bundleChkAudio')?.checked) {
      components.push({
        type: 'audio',
        quality: document.getElementById('bundleSelAudioQuality')?.value || '0',
        format: 'mp3',
        label: 'Audio (MP3)',
      });
    }
    if (document.getElementById('bundleChkSubtitle')?.checked) {
      components.push({
        type: 'subtitle',
        quality: '',
        format: 'srt',
        subLang: selections.subtitle.lang || 'vi',
        label: 'Phụ đề (SRT)',
      });
    }
    if (document.getElementById('bundleChkThumbnail')?.checked) {
      components.push({
        type: 'thumbnail',
        quality: 'maxresdefault',
        format: 'jpg',
        thumbRes: 'maxresdefault',
        label: 'Thumbnail (JPG)',
      });
    }
    if (document.getElementById('bundleChkMetadata')?.checked) {
      components.push({
        type: 'metadata',
        quality: '',
        format: 'txt',
        label: 'Metadata (TXT)',
      });
    }
    return components;
  }

  function buildTaskDescriptors() {
    const sources = getDownloadSources();
    const components = getDownloadComponents();
    const descriptors = [];

    sources.forEach(source => {
      components.forEach(component => {
        const thumbnailUrl = component.type === 'thumbnail' && source.id
          ? `https://img.youtube.com/vi/${source.id}/${component.thumbRes || 'maxresdefault'}.jpg`
          : source.thumbnail;
        descriptors.push({
          name: `${source.title} • ${component.label}`,
          opts: {
            url: source.url,
            type: component.type,
            quality: component.quality,
            format: component.format,
            subLang: component.subLang || selections.subtitle.lang || 'vi',
            subtitleLang: component.subLang || selections.subtitle.lang || 'vi',
            subtitleFormat: component.type === 'subtitle' ? component.format : selections.subtitle.format,
            thumbRes: component.thumbRes || selections.thumbnail.quality,
            outputPath: currentOutputDir,
            outputDir: currentOutputDir,
            title: source.title,
            thumbnail: source.thumbnail,
            thumbnailUrl,
            channel: source.channel,
          },
        });
      });
    });
    return descriptors;
  }

  function syncInlineSubtasks() {
    currentSubtasks = [
      ...Array.from(activeTasksMap.values()).map(task => ({
        name: `${task.title || 'Video YouTube'} • ${String(task.type || '').toUpperCase()}`,
        status: 'active',
        statusText: `${Math.max(0, Number(task.percent) || 0).toFixed(1)}%`,
      })),
      ...pendingTasks.map(item => ({
        name: item.name,
        status: 'pending',
        statusText: 'Chờ...',
      })),
    ];
    renderSubtasks();
    if (subtaskCountBadge) {
      subtaskCountBadge.textContent = `${activeTasksMap.size}/${currentSubtasks.length}`;
    }
  }

  function renderInlineTask(task) {
    if (!task) {
      if (pendingTasks.length === 0 && activeTasksMap.size === 0) {
        progressSection.classList.add('hidden');
        btnCancel.classList.add('hidden');
      }
      return;
    }

    const percent = Math.max(0, Math.min(Number(task.percent) || 0, 100));
    progressSection.classList.remove('hidden');
    btnCancel.classList.remove('hidden');
    progressLabel.textContent = `${task.title || 'Video YouTube'} • ${String(task.type || '').toUpperCase()}`;
    progressPercent.textContent = `${percent.toFixed(1)}%`;
    progressBar.style.width = `${percent}%`;
    progressSpeed.textContent = task.speed || '--';
    progressSize.textContent = `${activeTasksMap.size} đang tải • ${pendingTasks.length} đang chờ`;
    progressETA.textContent = task.eta || 'ETA: --';
  }

  function renderInlineQueueSummary() {
    const focused = activeTasksMap.get(focusedTaskId)
      || activeTasksMap.values().next().value;
    if (focused) {
      focusedTaskId = focused.id;
      renderInlineTask(focused);
    } else if (pendingTasks.length > 0) {
      progressSection.classList.remove('hidden');
      btnCancel.classList.add('hidden');
      progressLabel.textContent = 'Đang chờ khởi tạo tác vụ...';
      progressPercent.textContent = '0%';
      progressBar.style.width = '0%';
      progressSpeed.textContent = '--';
      progressSize.textContent = `${pendingTasks.length} đang chờ`;
      progressETA.textContent = 'ETA: --';
    } else {
      progressSection.classList.add('hidden');
      btnCancel.classList.add('hidden');
    }
    syncInlineSubtasks();
  }

  async function pumpTaskQueue() {
    if (queuePumpRunning) return;
    queuePumpRunning = true;
    try {
      while (pendingTasks.length > 0 && activeTasksMap.size < MAX_CONCURRENT_TASKS) {
        const pending = pendingTasks.shift();
        try {
          const task = await window.ytdlp.startDownloadTask(pending.opts);
          if (!task?.id) throw new Error('Backend không trả về mã tác vụ');
          activeTasksMap.set(task.id, task);
          if (!focusedTaskId) focusedTaskId = task.id;
        } catch (error) {
          showToast(`Không thể khởi tạo "${pending.opts.title}": ${error.message || error}`, 'error');
        }
        updateQueueBadges();
        renderActiveQueue();
        renderInlineQueueSummary();
      }
    } finally {
      queuePumpRunning = false;
    }
  }

  function showQueueCompletion() {
    if (queueCompletionShown || !queueHadCompletion || !lastDownloadedFile) return;
    queueCompletionShown = true;
    progressSection.classList.add('hidden');
    btnCancel.classList.add('hidden');
    doneSection.classList.remove('hidden');
    doneFileName.textContent = lastDownloadedFile.split(/[/\\]/).pop() || 'Tải xuống thành công';
    showToast('Tải xuống hoàn tất!', 'success');

    if (currentSettings.autoOpenFolder) {
      clearTimeout(autoOpenTimer);
      autoOpenTimer = setTimeout(() => {
        window.ytdlp.openFolder(lastDownloadedFolder || lastDownloadedFile || currentOutputDir);
      }, 350);
    }
  }

  btnDownload.addEventListener('click', async () => {
    if (!videoInfo && !playlistData) return;
    const descriptors = buildTaskDescriptors();
    if (playlistData && getDownloadSources().length === 0) {
      showToast('Vui lòng chọn ít nhất một video trong playlist.', 'error');
      return;
    }
    if (descriptors.length === 0) {
      showToast('Vui lòng chọn ít nhất một thành phần để tải.', 'error');
      return;
    }

    if (activeTasksMap.size === 0 && pendingTasks.length === 0) {
      clearTimeout(autoOpenTimer);
      queueHadCompletion = false;
      queueCompletionShown = false;
      lastDownloadedFile = '';
      lastDownloadedFolder = '';
    }
    doneSection.classList.add('hidden');
    descriptors.forEach(descriptor => {
      pendingTasks.push({
        ...descriptor,
        localId: `pending_${Date.now()}_${pendingSequence++}`,
      });
    });
    updateQueueBadges();
    renderActiveQueue();
    renderInlineQueueSummary();
    const message = descriptors.length === 1
      ? `Đã thêm "${descriptors[0].opts.title}" vào hàng đợi tải!`
      : `Đã thêm ${descriptors.length} tác vụ vào hàng đợi tải!`;
    showToast(message, 'success');
    await pumpTaskQueue();
  });

  btnCancel.addEventListener('click', async () => {
    if (!focusedTaskId) return;
    try {
      await window.ytdlp.cancelDownloadTask(focusedTaskId);
    } catch (error) {
      showToast(`Không thể hủy: ${error.message || error}`, 'error');
    }
  });

  window.ytdlp.onTaskUpdated(async task => {
    if (!task?.id) return;
    const terminal = ['completed', 'error', 'cancelled'].includes(task.status);

    if (terminal) {
      activeTasksMap.delete(task.id);
      if (task.status === 'completed') {
        queueHadCompletion = true;
        lastDownloadedFile = task.filePath || lastDownloadedFile;
        lastDownloadedFolder = task.folderPath || lastDownloadedFolder;
      } else if (task.status === 'error') {
        showToast(`Lỗi tải "${task.title || 'video'}": ${task.error || 'Không xác định'}`, 'error');
      } else {
        showToast(`Đã hủy "${task.title || 'tác vụ'}".`, 'info');
      }
      if (focusedTaskId === task.id) focusedTaskId = '';
    } else {
      activeTasksMap.set(task.id, task);
      if (!focusedTaskId) focusedTaskId = task.id;
    }

    updateQueueBadges();
    renderActiveQueue();
    renderInlineQueueSummary();
    if (task.status === 'completed') renderCompletedHistory();
    if (terminal) {
      await pumpTaskQueue();
      if (activeTasksMap.size === 0 && pendingTasks.length === 0) {
        showQueueCompletion();
      }
    }
  });

  async function loadInitialTasks() {
    try {
      const tasks = await window.ytdlp.getActiveTasks();
      activeTasksMap.clear();
      if (Array.isArray(tasks)) {
        tasks.filter(task => task?.id && task.status === 'running')
          .forEach(task => activeTasksMap.set(task.id, task));
      }
      focusedTaskId = activeTasksMap.keys().next().value || '';
    } catch (error) {
      console.error('Không thể đọc tác vụ đang chạy:', error);
    }
    updateQueueBadges();
    renderActiveQueue();
    renderInlineQueueSummary();
  }

  // ═══ Done Actions ═══

  if (btnCloseDone) {
    btnCloseDone.addEventListener('click', () => {
      doneSection.classList.add('hidden');
    });
  }

  btnOpenFile.addEventListener('click', () => {
    if (lastDownloadedFile) {
      window.ytdlp.openFile(lastDownloadedFile);
    } else {
      window.ytdlp.openFolder(currentOutputDir);
    }
  });

  btnOpenFolder.addEventListener('click', () => {
    window.ytdlp.openFolder(lastDownloadedFolder || lastDownloadedFile || currentOutputDir);
  });

  if (btnCopyPath) {
    btnCopyPath.addEventListener('click', async () => {
      if (lastDownloadedFile) {
        try {
          await navigator.clipboard.writeText(lastDownloadedFile);
          showToast('Đã sao chép đường dẫn file!', 'success');
        } catch {
          showToast('Không thể copy đường dẫn', 'error');
        }
      }
    });
  }

  btnNewDownload.addEventListener('click', () => {
    urlInput.value = '';
    btnClear.classList.add('hidden');
    btnPaste.classList.remove('hidden');
    resetVideoState();
    urlInput.focus();
  });

  // ═══ Init ═══

  initChipGroups();
  await loadPersistentSettings();
  const setupOk = await checkAndSetup();
  if (setupOk) {
    await loadInitialTasks();
    await renderCompletedHistory();
    urlInput.focus();
  }
});
