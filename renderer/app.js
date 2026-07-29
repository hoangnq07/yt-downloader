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

  const btnHistoryToggle = document.getElementById('btnHistoryToggle');
  const historyDrawerOverlay = document.getElementById('historyDrawerOverlay');
  const btnCloseHistory = document.getElementById('btnCloseHistory');
  const btnClearHistory = document.getElementById('btnClearHistory');
  const historyList = document.getElementById('historyList');
  const historyBadge = document.getElementById('historyBadge');

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

  function initSubtasks(tasks) {
    currentSubtasks = tasks.map((t, idx) => ({ ...t, id: idx, status: idx === 0 ? 'active' : 'pending', statusText: idx === 0 ? 'Đang chạy' : 'Chờ' }));
    renderSubtasks();
  }

  function updateSubtaskStatus(activeIndex, statusText = 'Đang chạy') {
    currentSubtasks.forEach((st, idx) => {
      if (idx < activeIndex) {
        st.status = 'done';
        st.statusText = '✔ Hoàn tất';
      } else if (idx === activeIndex) {
        st.status = 'active';
        st.statusText = statusText;
      } else {
        st.status = 'pending';
        st.statusText = 'Chờ...';
      }
    });
    renderSubtasks();
  }

  function finishSubtasks() {
    currentSubtasks.forEach(st => {
      st.status = 'done';
      st.statusText = '✔ Hoàn tất';
    });
    renderSubtasks();
  }

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
      div.innerHTML = `
        <span>${st.name}</span>
        <span class="subtask-status">${st.statusText || 'Chờ...'}</span>
      `;
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
      langLabel: 'Ngôn ngữ ứng dụng',
      themeLabel: 'Màu giao diện chủ đạo',
      urlPlaceholder: 'Dán link YouTube vào đây...',
      urlHint: 'Hỗ trợ youtube.com, youtu.be, shorts, live, playlist',
      tabVideo: 'Video',
      tabAudio: 'Audio',
      tabSubtitle: 'Phụ đề',
      tabThumbnail: 'Thumbnail',
      tabBundle: 'Tải tất cả',
      downloadBtn: 'Tải xuống',
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
      langLabel: 'App Language',
      themeLabel: 'Accent Theme',
      urlPlaceholder: 'Paste YouTube link here...',
      urlHint: 'Supports youtube.com, youtu.be, shorts, live, playlists',
      tabVideo: 'Video',
      tabAudio: 'Audio',
      tabSubtitle: 'Subtitles',
      tabThumbnail: 'Thumbnail',
      tabBundle: 'Download All',
      downloadBtn: 'Download',
      cancelBtn: 'Cancel',
      subtasksLabel: 'Details',
      doneTitle: 'Download Complete!',
      openFile: 'Open File',
      openFolder: 'Open Folder',
    }
  };

  function applyLanguage(lang) {
    localStorage.setItem('lang', lang);
    const t = translations[lang] || translations.vi;

    langCards.forEach(card => {
      card.classList.toggle('active', card.dataset.lang === lang);
    });

    if (urlInput) urlInput.placeholder = t.urlPlaceholder;
    if (urlHint) urlHint.textContent = t.urlHint;

    const btnSettingsText = document.querySelector('#btnSettingsToggle span');
    if (btnSettingsText) btnSettingsText.textContent = t.settingsBtn;

    const btnHistoryText = document.querySelector('#btnHistoryToggle span');
    if (btnHistoryText) btnHistoryText.textContent = t.historyBtn;

    const tabVideoSpan = document.querySelector('#tabVideo span');
    if (tabVideoSpan) tabVideoSpan.textContent = t.tabVideo;

    const tabAudioSpan = document.querySelector('#tabAudio span');
    if (tabAudioSpan) tabAudioSpan.textContent = t.tabAudio;

    const tabSubSpan = document.querySelector('#tabSubtitle span');
    if (tabSubSpan) tabSubSpan.textContent = t.tabSubtitle;

    const tabThumbSpan = document.querySelector('#tabThumbnail span');
    if (tabThumbSpan) tabThumbSpan.textContent = t.tabThumbnail;

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

  const savedLang = localStorage.getItem('lang') || 'vi';
  applyLanguage(savedLang);

  langCards.forEach(card => {
    card.addEventListener('click', () => {
      const selectedLang = card.dataset.lang;
      applyLanguage(selectedLang);
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
    localStorage.setItem('theme', theme);
    themeCards.forEach(card => {
      card.classList.toggle('active', card.dataset.theme === theme);
    });
  }

  const savedTheme = localStorage.getItem('theme') || 'red';
  applyTheme(savedTheme);

  themeCards.forEach(card => {
    card.addEventListener('click', () => {
      const themeName = card.dataset.theme;
      applyTheme(themeName);
      const name = card.querySelector('.theme-name')?.textContent || themeName;
      showToast(`Đã đổi màu giao diện sang ${name}!`, 'success');
    });
  });

  // ═══ History Drawer ═══

  function getHistory() {
    try {
      return JSON.parse(localStorage.getItem('downloadHistory') || '[]');
    } catch { return []; }
  }

  function saveHistory(list) {
    localStorage.setItem('downloadHistory', JSON.stringify(list));
    updateHistoryBadge();
  }

  function updateHistoryBadge() {
    const history = getHistory();
    if (historyBadge) {
      if (history.length > 0) {
        historyBadge.textContent = history.length;
        historyBadge.classList.remove('hidden');
      } else {
        historyBadge.classList.add('hidden');
      }
    }
  }

  function addHistoryItem(item) {
    const history = getHistory();
    history.unshift({
      id: Date.now(),
      title: item.title || 'Untitled',
      type: item.type || 'video',
      quality: item.quality || '',
      format: item.format || '',
      filePath: item.filePath || '',
      thumbnail: item.thumbnail || '',
      time: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
    });
    saveHistory(history.slice(0, 50));
  }

  function renderHistory() {
    if (!historyList) return;
    const history = getHistory();
    if (history.length === 0) {
      historyList.innerHTML = '<p class="history-empty">Chưa có lịch sử tải xuống nào</p>';
      return;
    }

    historyList.innerHTML = '';
    history.forEach((item, index) => {
      const el = document.createElement('div');
      el.className = 'history-item';
      el.innerHTML = `
        <img class="history-thumb" src="${item.thumbnail || ''}" alt="">
        <div class="history-details">
          <div class="history-item-title" title="${item.title}">${item.title}</div>
          <div class="history-item-meta">
            <span class="history-item-type">${item.type} (${item.format})</span>
            <span>${item.time}</span>
          </div>
          <div class="history-item-actions">
            <button class="hist-action-btn" data-act="openFile" data-idx="${index}">Mở file</button>
            <button class="hist-action-btn" data-act="openFolder" data-idx="${index}">Mở thư mục</button>
            <button class="hist-action-btn" data-act="remove" data-idx="${index}">Xóa</button>
          </div>
        </div>
      `;
      historyList.appendChild(el);
    });

    historyList.querySelectorAll('.hist-action-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        const idx = parseInt(btn.dataset.idx);
        const list = getHistory();
        const item = list[idx];
        if (!item) return;

        if (act === 'openFile') window.ytdlp.openFile(item.filePath);
        else if (act === 'openFolder') window.ytdlp.openFolder(currentOutputDir);
        else if (act === 'remove') {
          list.splice(idx, 1);
          saveHistory(list);
          renderHistory();
        }
      });
    });
  }

  btnHistoryToggle?.addEventListener('click', () => {
    renderHistory();
    historyDrawerOverlay?.classList.remove('hidden');
  });

  btnCloseHistory?.addEventListener('click', () => {
    historyDrawerOverlay?.classList.add('hidden');
  });

  btnClearHistory?.addEventListener('click', () => {
    saveHistory([]);
    renderHistory();
    showToast('Đã xóa toàn bộ lịch sử!');
  });

  updateHistoryBadge();

  // ═══ State ═══

  let videoInfo = null;
  let currentTab = 'video';
  let currentOutputDir = '';
  let lastDownloadedFile = '';
  let isDownloading = false;
  let debounceTimer = null;

  // Chip state per tab
  const selections = {
    video: { quality: 'best', format: 'mp4' },
    audio: { quality: 'best', format: 'mp3' },
    subtitle: { lang: '', format: 'srt' },
    thumbnail: { quality: 'maxresdefault', format: 'jpg' },
  };

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

    // Load download path
    currentOutputDir = await window.ytdlp.getDownloadPath();
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

  // ═══ Fetch Video Info ═══

  async function fetchVideoInfo(url) {
    if (!url) return;

    // Basic URL validation
    if (!url.match(/youtu\.?be/i) && !url.match(/^[a-zA-Z0-9_-]{11}$/)) {
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
      const isDedicatedPlaylist = url.includes('/playlist?') || (url.includes('list=PL') && !url.includes('watch?v='));

      if (isDedicatedPlaylist) {
        await checkAndLoadPlaylist(url);
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
      videoInfo = await window.ytdlp.getInfo(cleanUrl);

      // Render info card
      infoThumb.src = videoInfo.thumbnail;
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
      setHint('Lỗi: ' + (err.message || 'Không thể lấy thông tin'), 'error');
      showToast('Không thể lấy thông tin video', 'error');
    } finally {
      urlLoading.classList.add('hidden');
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
      btn.innerHTML = `${sub.code.toUpperCase()} <span class="auto-badge official">SUB</span>`;
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

  async function checkAndLoadPlaylist(url) {
    try {
      setHint('Đang tải danh sách Playlist...');
      playlistData = await window.ytdlp.getPlaylistInfo(url);
      if (playlistData && playlistData.entries.length > 0) {
        renderPlaylist(playlistData);
        return true;
      }
    } catch (e) {
      console.log('Playlist check error:', e);
    }
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
      row.innerHTML = `
        <label class="custom-checkbox">
          <input type="checkbox" class="chk-playlist-item" data-url="${item.url}" data-title="${item.title}" checked>
          <span class="checkmark"></span>
        </label>
        <span class="playlist-item-title">${i + 1}. ${item.title}</span>
      `;
      playlistItemsList.appendChild(row);
    });

    playlistCard.classList.remove('hidden');

    chkSelectAllPlaylist?.addEventListener('change', () => {
      playlistItemsList.querySelectorAll('.chk-playlist-item').forEach(chk => {
        chk.checked = chkSelectAllPlaylist.checked;
      });
    });
  }

  function resetVideoState() {
    videoInfo = null;
    playlistData = null;
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
    }
  });

  // ═══ Download Action ═══

  btnDownload.addEventListener('click', async () => {
    if ((!videoInfo && !playlistData) || isDownloading) return;

    isDownloading = true;
    btnDownload.classList.add('hidden');
    btnCancel.classList.remove('hidden');
    progressSection.classList.remove('hidden');
    doneSection.classList.add('hidden');

    progressBar.style.width = '0%';
    progressPercent.textContent = '0%';
    progressLabel.textContent = 'Đang chuẩn bị...';
    progressSpeed.textContent = '--';
    progressSize.textContent = '--';
    progressETA.textContent = '--';

    const sel = selections[currentTab];

    // Check if downloading Playlist batch
    const checkedPlaylistItems = playlistItemsList ? Array.from(playlistItemsList.querySelectorAll('.chk-playlist-item:checked')) : [];

    if (currentTab === 'bundle') {
      // ⚡ Bundle Download (Quick All-in-One)
      const url = urlInput.value.trim();
      const chkVideo = document.getElementById('bundleChkVideo')?.checked;
      const chkAudio = document.getElementById('bundleChkAudio')?.checked;
      const chkSubtitle = document.getElementById('bundleChkSubtitle')?.checked;
      const chkThumbnail = document.getElementById('bundleChkThumbnail')?.checked;

      const selVidQual = document.getElementById('bundleSelVideoQuality')?.value || 'best';
      const selAudQual = document.getElementById('bundleSelAudioQuality')?.value || '0';

      const tasks = [];
      if (chkVideo) tasks.push({ type: 'video', quality: selVidQual, format: 'mp4', name: 'Video (MP4)' });
      if (chkAudio) tasks.push({ type: 'audio', quality: selAudQual, format: 'mp3', name: 'Audio (MP3)' });
      if (chkSubtitle) tasks.push({ type: 'subtitle', lang: selections.subtitle.lang || 'vi', format: 'srt', name: 'Phụ đề (SRT)' });
      if (chkThumbnail) tasks.push({ type: 'thumbnail', quality: 'maxresdefault', format: 'jpg', name: 'Thumbnail (JPG)' });

      if (tasks.length === 0) {
        showToast('Vui lòng tích chọn ít nhất 1 thành phần để tải!', 'error');
        isDownloading = false;
        btnCancel.classList.add('hidden');
        btnDownload.classList.remove('hidden');
        progressSection.classList.add('hidden');
        return;
      }

      initSubtasks(tasks);

      let successCount = 0;
      for (let i = 0; i < tasks.length; i++) {
        if (!isDownloading) break;
        const task = tasks[i];
        updateSubtaskStatus(i, 'Đang tải...');
        progressLabel.textContent = `[${i + 1}/${tasks.length}] Đang tải ${task.name}...`;

        const options = {
          url,
          type: task.type,
          format: task.format,
          quality: task.quality,
          subtitleLang: task.lang || 'vi',
          subtitleFormat: task.format || 'srt',
          outputDir: currentOutputDir,
        };

        if (task.type === 'thumbnail' && videoInfo) {
          options.thumbnailUrl = `https://img.youtube.com/vi/${videoInfo.id}/maxresdefault.jpg`;
          options.title = videoInfo.title;
        }

        try {
          const result = await window.ytdlp.download(options);
          if (result && result.success) {
            successCount++;
            lastDownloadedFile = result.file || lastDownloadedFile;
            if (videoInfo) {
              addHistoryItem({
                title: `${videoInfo.title} (${task.name})`,
                type: task.type,
                format: task.format,
                quality: task.quality,
                filePath: result.file || '',
                thumbnail: videoInfo.thumbnail,
              });
            }
          }
        } catch (e) {
          console.log('Bundle task error:', e);
        }
      }

      finishSubtasks();
      isDownloading = false;
      btnCancel.classList.add('hidden');
      btnDownload.classList.remove('hidden');
      progressSection.classList.add('hidden');

      if (successCount > 0) {
        doneSection.classList.remove('hidden');
        if (doneFileName) {
          doneFileName.textContent = `Đã tải thành công ${successCount}/${tasks.length} thành phần đã chọn!`;
        }
        showToast(`Tải thành công ${successCount} thành phần!`, 'success');
        if (chkAutoOpenFolder && chkAutoOpenFolder.checked) {
          window.ytdlp.openFolder(currentOutputDir);
        }
      }
      return;
    } else if (playlistData && checkedPlaylistItems.length > 0) {
      const total = checkedPlaylistItems.length;
      for (let i = 0; i < total; i++) {
        if (!isDownloading) break; // Cancelled
        const chk = checkedPlaylistItems[i];
        const itemUrl = chk.dataset.url;
        const itemTitle = chk.dataset.title;

        progressLabel.textContent = `[${i + 1}/${total}] Đang tải: ${itemTitle}`;
        const options = {
          url: itemUrl,
          type: currentTab,
          format: sel.format,
          quality: sel.quality,
          subtitleLang: sel.lang,
          subtitleFormat: sel.format,
          outputDir: currentOutputDir,
        };

        try {
          const res = await window.ytdlp.download(options);
          if (res.success && res.file) {
            lastDownloadedFile = res.file;
            addHistoryItem({
              title: itemTitle,
              type: currentTab,
              format: sel.format,
              quality: sel.quality,
              filePath: res.file,
              thumbnail: videoInfo?.thumbnail || '',
            });
          }
        } catch (e) {
          console.log('Batch item error:', e);
        }
      }
    } else {
      // Single Download
      initSubtasks([
        { name: '1. Khởi tạo luồng & kiểm tra định dạng' },
        { name: '2. Tải dữ liệu luồng media' },
        { name: '3. Ghép nối & hoàn thiện file' },
      ]);
      const url = urlInput.value.trim();
      const options = {
        url,
        type: currentTab,
        format: sel.format,
        quality: sel.quality,
        subtitleLang: sel.lang,
        subtitleFormat: sel.format,
        outputDir: currentOutputDir,
      };

      if (currentTab === 'thumbnail' && videoInfo) {
        const q = sel.quality || 'maxresdefault';
        options.thumbnailUrl = `https://img.youtube.com/vi/${videoInfo.id}/${q}.jpg`;
        options.title = videoInfo.title;
      }

      try {
        const result = await window.ytdlp.download(options);
        if (result.success) {
          lastDownloadedFile = result.file || '';
          if (videoInfo) {
            addHistoryItem({
              title: videoInfo.title,
              type: currentTab,
              format: sel.format,
              quality: sel.quality,
              filePath: lastDownloadedFile,
              thumbnail: videoInfo.thumbnail,
            });
          }
        }
      } catch (err) {
        showToast('Lỗi tải: ' + (err.message || 'Unknown'), 'error');
      }
    }

    isDownloading = false;
    btnCancel.classList.add('hidden');
    btnDownload.classList.remove('hidden');
  });

  btnCancel.addEventListener('click', async () => {
    await window.ytdlp.cancel();
    isDownloading = false;
    btnCancel.classList.add('hidden');
    btnDownload.classList.remove('hidden');
    progressSection.classList.add('hidden');
    showToast('Đã hủy tải.', 'info');
  });

  // ═══ Progress Listener ═══

  window.ytdlp.onProgress((data) => {
    switch (data.status) {
      case 'downloading':
        if (currentTab !== 'bundle') {
          updateSubtaskStatus(1, `${data.percent.toFixed(1)}%`);
        }
        if (!progressLabel.textContent.startsWith('[')) {
          progressLabel.textContent = 'Đang tải...';
        }
        progressPercent.textContent = data.percent.toFixed(1) + '%';
        progressBar.style.width = data.percent + '%';
        progressSpeed.textContent = data.speed || '--';
        progressETA.textContent = data.eta ? 'ETA: ' + data.eta : '--';
        progressSize.textContent = data.downloaded && data.totalSize
          ? `${data.downloaded} / ${data.totalSize}` : '--';
        break;

      case 'processing':
        if (currentTab !== 'bundle') {
          updateSubtaskStatus(2, 'Đang ghép file...');
        }
        progressLabel.textContent = data.message || 'Đang xử lý...';
        progressPercent.textContent = '100%';
        progressBar.style.width = '100%';
        break;

      case 'done':
        finishSubtasks();
        progressPercent.textContent = '100%';
        progressBar.style.width = '100%';
        if (currentTab === 'bundle' && isDownloading) {
          // Bỏ qua chuyển UI done giữa chừng khi đang tải vòng lặp bundle
          break;
        }
        progressSection.classList.add('hidden');
        doneSection.classList.remove('hidden');
        lastDownloadedFile = data.file || '';
        currentOutputDir = data.outputDir || currentOutputDir;

        if (doneFileName) {
          const fileName = lastDownloadedFile.split(/[/\\]/).pop() || 'Tải xuống thành công';
          doneFileName.textContent = fileName;
        }

        showToast('Tải thành công!', 'success');

        if (chkAutoOpenFolder && chkAutoOpenFolder.checked) {
          window.ytdlp.openFolder(currentOutputDir);
        }
        break;

      case 'error':
        progressSection.classList.add('hidden');
        showToast('Lỗi: ' + (data.message || 'Unknown'), 'error');
        break;

      case 'cancelled':
        progressSection.classList.add('hidden');
        break;
    }
  });

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
    window.ytdlp.openFolder(currentOutputDir);
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
  const setupOk = await checkAndSetup();
  if (setupOk) {
    urlInput.focus();
  }
});
