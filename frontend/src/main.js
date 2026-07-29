import {
  GetVideoInfo,
  GetPlaylistInfo,
  StartDownloadTask,
  CancelDownloadTask,
  GetActiveTasks,
  SelectFolder,
  OpenFolder,
  OpenFile,
  GetHistory,
  SaveHistory,
  ClearHistory,
  GetSettings,
  SaveSettings
} from '../wailsjs/go/main/App';

import {
  EventsOn,
  WindowMinimise,
  WindowToggleMaximise,
  Quit
} from '../wailsjs/runtime/runtime';

document.addEventListener('DOMContentLoaded', async () => {
  // ═══ Titlebar Window Controls ═══
  document.getElementById('btnMinimize')?.addEventListener('click', () => WindowMinimise());
  document.getElementById('btnMaximize')?.addEventListener('click', () => WindowToggleMaximise());
  document.getElementById('btnClose')?.addEventListener('click', () => Quit());

  // ═══ State Management ═══
  let videoInfo = null;
  let currentTab = 'video';
  let activeTasksMap = new Map();

  let currentSettings = {
    language: 'vi',
    theme: 'red',
    downloadPath: '',
    autoOpenFolder: false
  };

  const selections = {
    video: { quality: 'best', format: 'mp4' },
    audio: { quality: 'best', format: 'mp3' },
    subtitle: { lang: '', format: 'srt' },
    thumbnail: { quality: 'maxresdefault', format: 'jpg' },
    metadata: { format: 'txt' }
  };

  // Load Settings & Theme
  try {
    currentSettings = await GetSettings();
    applyTheme(currentSettings.theme);
    applyLanguage(currentSettings.language);
    if (currentSettings.downloadPath) {
      document.getElementById('folderPath').textContent = formatDisplayPath(currentSettings.downloadPath);
    }
    document.getElementById('chkAutoOpenFolder').checked = currentSettings.autoOpenFolder;
  } catch (e) {
    console.error(e);
  }

  // Initial History & Tasks Load
  renderCompletedHistory();
  loadInitialActiveTasks();

  // ═══ Main Top View Navigation Switching ═══
  const navBtnDownloader = document.getElementById('navBtnDownloader');
  const navBtnManager = document.getElementById('navBtnManager');
  const viewDownloader = document.getElementById('viewDownloader');
  const viewManager = document.getElementById('viewManager');

  navBtnDownloader?.addEventListener('click', () => {
    navBtnDownloader.classList.add('active');
    navBtnManager.classList.remove('active');
    viewDownloader.classList.add('active');
    viewManager.classList.remove('active');
  });

  navBtnManager?.addEventListener('click', () => {
    navBtnManager.classList.add('active');
    navBtnDownloader.classList.remove('active');
    viewManager.classList.add('active');
    viewDownloader.classList.remove('active');
    renderActiveQueue();
    renderCompletedHistory();
  });

  // Manager Sub-Nav Switching (Active Queue vs Completed History)
  const subBtnActiveQueue = document.getElementById('subBtnActiveQueue');
  const subBtnCompletedHistory = document.getElementById('subBtnCompletedHistory');
  const subContentActiveQueue = document.getElementById('subContentActiveQueue');
  const subContentCompletedHistory = document.getElementById('subContentCompletedHistory');

  subBtnActiveQueue?.addEventListener('click', () => {
    subBtnActiveQueue.classList.add('active');
    subBtnCompletedHistory.classList.remove('active');
    subContentActiveQueue.classList.add('active');
    subContentCompletedHistory.classList.remove('active');
    renderActiveQueue();
  });

  subBtnCompletedHistory?.addEventListener('click', () => {
    subBtnCompletedHistory.classList.add('active');
    subBtnActiveQueue.classList.remove('active');
    subContentCompletedHistory.classList.add('active');
    subContentActiveQueue.classList.remove('active');
    renderCompletedHistory();
  });

  document.getElementById('btnClearHistoryManager')?.addEventListener('click', async () => {
    await ClearHistory();
    renderCompletedHistory();
    showToast('Đã xóa toàn bộ lịch sử!', 'success');
  });

  // Settings Modal Controls
  const settingsModalOverlay = document.getElementById('settingsModalOverlay');
  document.getElementById('btnSettingsToggle')?.addEventListener('click', () => {
    settingsModalOverlay.classList.remove('hidden');
  });
  document.getElementById('btnCloseSettings')?.addEventListener('click', () => {
    settingsModalOverlay.classList.add('hidden');
  });

  // Theme & Language Swappers
  document.querySelectorAll('.theme-card').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.theme-card').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const theme = btn.getAttribute('data-theme');
      applyTheme(theme);
      currentSettings.theme = theme;
      await SaveSettings(currentSettings);
    });
  });

  document.querySelectorAll('.lang-card').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.lang-card').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const lang = btn.getAttribute('data-lang');
      applyLanguage(lang);
      currentSettings.language = lang;
      await SaveSettings(currentSettings);
    });
  });

  // Download Option Tabs (Video, Audio, Subtitle, Thumbnail, Metadata, Bundle)
  const tabs = document.querySelectorAll('.tab');
  const tabContents = document.querySelectorAll('.tab-content');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.getAttribute('data-tab');
      if (!target) return;
      currentTab = target;

      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      tabContents.forEach(tc => {
        tc.classList.toggle('active', tc.getAttribute('data-content') === target);
      });
    });
  });

  // Quality & Format Chips
  initChipGroups();

  function initChipGroups() {
    document.querySelectorAll('.chip-group').forEach(group => {
      group.addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (!chip || chip.classList.contains('unavailable')) return;

        group.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');

        const groupId = group.id;
        const value = chip.getAttribute('data-value');

        if (groupId === 'videoQualityChips') selections.video.quality = value;
        else if (groupId === 'videoFormatChips') selections.video.format = value;
        else if (groupId === 'audioQualityChips') selections.audio.quality = value;
        else if (groupId === 'audioFormatChips') selections.audio.format = value;
        else if (groupId === 'subtitleFormatChips') selections.subtitle.format = value;
        else if (groupId === 'thumbQualityChips') selections.thumbnail.quality = value;
        else if (groupId === 'thumbFormatChips') selections.thumbnail.format = value;
        else if (groupId === 'metadataFormatChips') selections.metadata.format = value;
      });
    });
  }

  // ═══ Elements ═══
  const urlInput = document.getElementById('urlInput');
  const btnPaste = document.getElementById('btnPaste');
  const btnClear = document.getElementById('btnClear');
  const urlLoading = document.getElementById('urlLoading');
  const urlHint = document.getElementById('urlHint');

  const infoCard = document.getElementById('infoCard');
  const infoThumb = document.getElementById('infoThumb');
  const infoTitle = document.getElementById('infoTitle');
  const infoChannelName = document.getElementById('infoChannelName');
  const infoViewCount = document.getElementById('infoViewCount');
  const infoDuration = document.getElementById('infoDuration');

  const playlistCard = document.getElementById('playlistCard');
  const playlistTitle = document.getElementById('playlistTitle');
  const playlistCountBadge = document.getElementById('playlistCountBadge');
  const playlistItemsList = document.getElementById('playlistItemsList');
  const chkSelectAllPlaylist = document.getElementById('chkSelectAllPlaylist');

  const downloadPanel = document.getElementById('downloadPanel');
  const subtitleList = document.getElementById('subtitleList');
  const btnDownload = document.getElementById('btnDownload');

  const toast = document.getElementById('toast');
  const toastMessage = document.getElementById('toastMessage');

  // ═══ URL Input Handling ═══
  btnPaste?.addEventListener('click', async () => {
    try {
      if (navigator.clipboard) {
        const text = await navigator.clipboard.readText();
        if (text) {
          urlInput.value = text.trim();
          btnClear.classList.remove('hidden');
          btnPaste.classList.add('hidden');
          fetchVideoInfo(text.trim());
        }
      }
    } catch (e) {
      showToast('Không thể đọc clipboard', 'error');
    }
  });

  btnClear?.addEventListener('click', () => {
    urlInput.value = '';
    btnClear.classList.add('hidden');
    btnPaste.classList.remove('hidden');
    hideAllPanels();
    urlInput.focus();
  });

  urlInput?.addEventListener('input', () => {
    const val = urlInput.value.trim();
    btnClear.classList.toggle('hidden', !val);
    btnPaste.classList.toggle('hidden', !!val);

    if (val.startsWith('http://') || val.startsWith('https://')) {
      fetchVideoInfo(val);
    } else {
      hideAllPanels();
    }
  });

  async function fetchVideoInfo(url) {
    if (!url) return;
    urlLoading.classList.remove('hidden');
    hideAllPanels();
    setHint('Đang lấy thông tin video từ YouTube...');

    try {
      if (url.includes('/playlist?') || (url.includes('list=PL') && !url.includes('watch?v='))) {
        const items = await GetPlaylistInfo(url);
        if (items && items.length > 0) {
          renderPlaylist(items);
          playlistCard.classList.remove('hidden');
          downloadPanel.classList.remove('hidden');
          setHint(`Đã tải danh sách Playlist (${items.length} video)!`, 'success');
        } else {
          setHint('Không thể đọc dữ liệu Playlist.', 'error');
        }
        return;
      }

      const info = await GetVideoInfo(url);
      videoInfo = info;

      infoThumb.src = info.thumbnail || '';
      infoTitle.textContent = info.title || 'Video Title';
      infoChannelName.textContent = info.channel || info.uploader || 'YouTube';
      infoViewCount.textContent = formatViews(info.view_count || info.viewCount);

      const durationSecs = info.duration || 0;
      const mins = Math.floor(durationSecs / 60);
      const secs = durationSecs % 60;
      infoDuration.textContent = info.duration_string || `${mins}:${String(secs).padStart(2, '0')}`;

      renderSubtitles(info);
      markAvailableQualities(info);

      infoCard.classList.remove('hidden');
      downloadPanel.classList.remove('hidden');
      setHint('Sẵn sàng tải xuống!', 'success');

    } catch (err) {
      setHint(`Lỗi: ${err.message || err}`, 'error');
      showToast('Không thể lấy thông tin video', 'error');
    } finally {
      urlLoading.classList.add('hidden');
    }
  }

  function renderSubtitles(info) {
    subtitleList.innerHTML = '';
    let officialSubs = [];

    if (Array.isArray(info.subtitles)) {
      officialSubs = info.subtitles.map(s => ({
        code: typeof s === 'string' ? s : (s.code || s.name || ''),
        name: (s.name || s.code || '').toUpperCase()
      }));
    } else if (info.subtitles && typeof info.subtitles === 'object') {
      officialSubs = Object.keys(info.subtitles).map(lang => ({
        code: lang,
        name: lang.toUpperCase()
      }));
    }

    officialSubs.sort((a, b) => {
      if (a.code === 'vi') return -1;
      if (b.code === 'vi') return 1;
      if (a.code === 'en') return -1;
      if (b.code === 'en') return 1;
      return (a.code || '').localeCompare(b.code || '');
    });

    if (officialSubs.length === 0) {
      subtitleList.innerHTML = '<p class="empty-hint">Video này không có phụ đề chính thức</p>';
      document.querySelectorAll('#subtitleFormatChips .chip').forEach(c => c.classList.add('unavailable'));
      return;
    }

    document.querySelectorAll('#subtitleFormatChips .chip').forEach(c => c.classList.remove('unavailable'));
    officialSubs.forEach((sub, idx) => {
      const btn = document.createElement('button');
      btn.className = `sub-chip ${idx === 0 ? 'active' : ''}`;
      btn.setAttribute('data-value', sub.code);
      btn.style.cssText = 'padding: 6px 12px; background: rgba(255,255,255,0.05); border: 1px solid var(--border-color); border-radius: 6px; color: #fff; cursor: pointer; font-size: 12px;';
      btn.textContent = `${sub.code.toUpperCase()} (SUB)`;

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

    const availableHeights = new Set(
      info.formats.filter(f => f.height && f.vcodec !== 'none').map(f => f.height)
    );

    let maxVideoHeight = 0;
    availableHeights.forEach(h => { if (h > maxVideoHeight) maxVideoHeight = h; });

    let firstAvailableVideoChip = null;

    document.querySelectorAll('#videoQualityChips .chip').forEach(chip => {
      const val = chip.getAttribute('data-value');
      const labels = { 'best': 'Best', '2160': '4K (2160p)', '1080': '1080p', '720': '720p', '480': '480p', '360': '360p' };
      const label = labels[val] || val;
      chip.textContent = label;

      if (val === 'best') {
        chip.classList.remove('unavailable');
        if (!firstAvailableVideoChip) firstAvailableVideoChip = chip;
        return;
      }

      const numVal = parseInt(val, 10);
      if (!isNaN(numVal)) {
        const isAvailable = availableHeights.has(numVal) || (maxVideoHeight > 0 && numVal <= maxVideoHeight);

        if (isAvailable) {
          chip.classList.remove('unavailable');
          if (!firstAvailableVideoChip) firstAvailableVideoChip = chip;
        } else {
          chip.classList.add('unavailable');
          chip.classList.remove('active');
        }
      }
    });

    const activeVideoChip = document.querySelector('#videoQualityChips .chip.active');
    if (!activeVideoChip && firstAvailableVideoChip) {
      firstAvailableVideoChip.classList.add('active');
      selections.video.quality = firstAvailableVideoChip.getAttribute('data-value');
    }
  }

  function renderPlaylist(items) {
    playlistTitle.textContent = 'YouTube Playlist';
    playlistCountBadge.textContent = `${items.length} video`;
    playlistItemsList.innerHTML = '';

    items.forEach((item, idx) => {
      const div = document.createElement('div');
      div.className = 'playlist-item';
      div.innerHTML = `
        <label class="custom-checkbox">
          <input type="checkbox" class="chk-playlist-item" data-idx="${idx}" checked>
          <span class="checkmark"></span>
        </label>
        <span class="p-num" style="font-size: 12px; color: #71717A; width: 24px;">${idx + 1}</span>
        <div class="p-info" style="flex: 1;">
          <p style="font-size: 13px; font-weight: 600; color: #fff;">${escapeHtml(item.title || 'Untitled')}</p>
          <p style="font-size: 11px; color: #71717A;">${escapeHtml(item.uploader || item.channel || 'YouTube')}</p>
        </div>
      `;
      playlistItemsList.appendChild(div);
    });

    chkSelectAllPlaylist.checked = true;
    chkSelectAllPlaylist.onchange = (e) => {
      document.querySelectorAll('.chk-playlist-item').forEach(c => c.checked = e.target.checked);
    };
  }

  // ═══ NON-BLOCKING Multi-Task Download Action ═══
  btnDownload?.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url || !videoInfo) return;

    const activeTab = document.querySelector('.tab-bar .tab.active')?.getAttribute('data-tab') || 'video';

    const opts = {
      url: url,
      type: activeTab,
      quality: selections[activeTab]?.quality || 'best',
      format: selections[activeTab]?.format || 'mp4',
      subLang: selections.subtitle.lang || 'vi',
      outputPath: currentSettings.downloadPath,
      title: videoInfo.title || 'Video YouTube',
      thumbnail: videoInfo.thumbnail || '',
      channel: videoInfo.channel || 'YouTube',
      bundleOpts: {
        video: document.getElementById('bundleChkVideo').checked,
        videoQual: 'best',
        audio: document.getElementById('bundleChkAudio').checked,
        audioQual: '0',
        sub: document.getElementById('bundleChkSubtitle').checked,
        thumb: document.getElementById('bundleChkThumbnail').checked,
        metadata: document.getElementById('bundleChkMetadata').checked
      }
    };

    try {
      const task = await StartDownloadTask(opts);
      if (task && task.id) {
        activeTasksMap.set(task.id, task);
        updateQueueBadges();
        showToast(`🚀 Đã thêm "${task.title}" vào hàng đợi tải!`, 'success');
      }
    } catch (err) {
      showToast(`❌ Lỗi khởi tạo: ${err.message || err}`, 'error');
    }
  });

  // Real-Time Task Progress Event Listener
  EventsOn('task-updated', (task) => {
    if (!task || !task.id) return;
    
    if (task.status === 'running') {
      activeTasksMap.set(task.id, task);
    } else {
      activeTasksMap.delete(task.id);
      renderCompletedHistory();
    }

    updateQueueBadges();
    renderActiveQueue();
  });

  async function loadInitialActiveTasks() {
    try {
      const tasks = await GetActiveTasks();
      activeTasksMap.clear();
      if (tasks && tasks.length > 0) {
        tasks.forEach(t => {
          if (t.status === 'running') activeTasksMap.set(t.id, t);
        });
      }
      updateQueueBadges();
      renderActiveQueue();
    } catch (e) {
      console.error(e);
    }
  }

  function updateQueueBadges() {
    const runningCount = activeTasksMap.size;
    const navBadge = document.getElementById('navQueueBadge');
    const queueBadge = document.getElementById('activeQueueBadge');

    if (runningCount > 0) {
      if (navBadge) { navBadge.textContent = runningCount; navBadge.classList.remove('hidden'); }
      if (queueBadge) { queueBadge.textContent = runningCount; }
    } else {
      if (navBadge) navBadge.classList.add('hidden');
      if (queueBadge) queueBadge.textContent = '0';
    }
  }

  function renderActiveQueue() {
    const queueListEl = document.getElementById('activeQueueList');
    if (!queueListEl) return;

    if (activeTasksMap.size === 0) {
      queueListEl.innerHTML = '<p class="queue-empty">Chưa có tiến trình tải nào đang chạy</p>';
      return;
    }

    queueListEl.innerHTML = Array.from(activeTasksMap.values()).map(t => `
      <div class="task-card">
        <img class="task-thumb" src="${t.thumbnail || ''}" alt="">
        <div class="task-info-group">
          <div class="task-title" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</div>
          <div class="task-meta-row">
            <span>${t.type.toUpperCase()} (${t.format.toUpperCase()}) • ${t.speed || '-- MB/s'}</span>
            <span>${t.percent.toFixed(1)}% | ${t.eta || 'ETA: --'}</span>
          </div>
          <div class="task-progress-track">
            <div class="task-progress-fill" style="width: ${Math.min(t.percent, 100)}%;"></div>
          </div>
        </div>
        <button class="task-cancel-btn" data-taskid="${t.id}">Hủy</button>
      </div>
    `).join('');

    queueListEl.querySelectorAll('.task-cancel-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const tid = btn.getAttribute('data-taskid');
        if (tid) {
          await CancelDownloadTask(tid);
          activeTasksMap.delete(tid);
          updateQueueBadges();
          renderActiveQueue();
          showToast('⚠️ Đã hủy tiến trình tải xuống');
        }
      });
    });
  }

  async function renderCompletedHistory() {
    const listEl = document.getElementById('managerHistoryList');
    if (!listEl) return;

    try {
      const history = await GetHistory();
      if (!history || history.length === 0) {
        listEl.innerHTML = '<p class="history-empty">Chưa có lịch sử tải xuống nào</p>';
        return;
      }

      listEl.innerHTML = history.map((item, idx) => `
        <div class="task-card" style="margin-bottom: 8px;">
          <img class="task-thumb" src="${item.thumbnail || ''}" alt="">
          <div class="task-info-group">
            <div class="task-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
            <div class="task-meta-row">
              <span>${escapeHtml(item.channel || 'YouTube')} • ${item.date}</span>
              <span style="color: #10B981; font-weight: 700;">✔ Hoàn tất</span>
            </div>
          </div>
          <div style="display: flex; gap: 6px;">
            <button class="done-btn done-btn-primary" data-act="openFile" data-path="${escapeHtml(item.filePath)}">Mở file</button>
            <button class="done-btn" data-act="openFolder" data-path="${escapeHtml(item.filePath)}">Mở thư mục</button>
            <button class="done-btn" data-act="copyPath" data-path="${escapeHtml(item.filePath)}">Copy</button>
            <button class="done-btn" data-act="remove" data-idx="${idx}">✕</button>
          </div>
        </div>
      `).join('');

      listEl.querySelectorAll('[data-act]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const act = btn.getAttribute('data-act');
          const path = btn.getAttribute('data-path');
          const idx = parseInt(btn.getAttribute('data-idx'));

          if (act === 'openFile' && path) OpenFile(path);
          else if (act === 'openFolder') OpenFolder(currentSettings.downloadPath);
          else if (act === 'copyPath' && path) {
            navigator.clipboard.writeText(path);
            showToast('Đã sao chép đường dẫn file!', 'success');
          } else if (act === 'remove') {
            const h = await GetHistory();
            h.splice(idx, 1);
            await SaveHistory(h);
            renderCompletedHistory();
          }
        });
      });
    } catch (e) {
      console.error(e);
    }
  }

  // Settings & Folder Selection
  document.getElementById('btnFolder')?.addEventListener('click', async () => {
    try {
      const folder = await SelectFolder();
      if (folder) {
        document.getElementById('folderPath').textContent = formatDisplayPath(folder);
        currentSettings.downloadPath = folder;
      }
    } catch (e) {
      console.error(e);
    }
  });

  document.getElementById('chkAutoOpenFolder')?.addEventListener('change', async (e) => {
    currentSettings.autoOpenFolder = e.target.checked;
    await SaveSettings(currentSettings);
  });

  // Helpers
  function applyTheme(theme) {
    document.body.setAttribute('data-theme', theme || 'red');
  }

  function applyLanguage(lang) {
    const isVi = lang === 'vi';
    document.getElementById('lblSettingsTitle').textContent = isVi ? 'Cài đặt ứng dụng' : 'Application Settings';
    document.getElementById('lblLang').textContent = isVi ? 'Ngôn ngữ ứng dụng' : 'Application Language';
    document.getElementById('lblTheme').textContent = isVi ? 'Màu giao diện chủ đạo' : 'Primary Theme Color';
    document.getElementById('btnSettingsText').textContent = isVi ? 'Cài đặt' : 'Settings';
  }

  function showToast(msg, type = 'info') {
    toastMessage.textContent = msg;
    toast.className = `toast ${type}`;
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 3500);
  }

  function setHint(text, type = '') {
    if (urlHint) {
      urlHint.textContent = text;
      urlHint.className = `url-hint ${type}`;
    }
  }

  function hideAllPanels() {
    infoCard.classList.add('hidden');
    downloadPanel.classList.add('hidden');
    playlistCard?.classList.add('hidden');
  }

  function formatViews(n) {
    if (!n) return '0 lượt xem';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + ' tỷ lượt xem';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + ' triệu lượt xem';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + ' nghìn lượt xem';
    return n.toLocaleString('vi-VN') + ' lượt xem';
  }

  function formatDisplayPath(pathStr) {
    return (pathStr || '').replace(/\\/g, '/').replace(/^[A-Z]:\/Users\/[^/]+/, '~');
  }

  function escapeHtml(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
});
