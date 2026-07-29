import { GetVideoInfo, DownloadVideo, OpenFolder, SelectFolder, GetOutputDir } from '../wailsjs/go/main/App';
import { EventsOn } from '../wailsjs/runtime/runtime';

document.addEventListener('DOMContentLoaded', async () => {
  // Tab Navigation
  const navButtons = document.querySelectorAll('.nav-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  navButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');
      navButtons.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      document.getElementById(targetTab)?.classList.add('active');
    });
  });

  // Controls & Elements
  const urlInput = document.getElementById('urlInput');
  const btnPaste = document.getElementById('btnPaste');
  const btnFetch = document.getElementById('btnFetch');
  const statusBanner = document.getElementById('statusBanner');
  const statusIcon = document.getElementById('statusIcon');
  const statusMessage = document.getElementById('statusMessage');
  
  const videoCard = document.getElementById('videoCard');
  const videoThumb = document.getElementById('videoThumb');
  const videoTitle = document.getElementById('videoTitle');
  const videoChannel = document.getElementById('videoChannel');
  const videoDuration = document.getElementById('videoDuration');
  
  const selQuality = document.getElementById('selQuality');
  const btnDownload = document.getElementById('btnDownload');
  
  const progressSection = document.getElementById('progressSection');
  const progressBar = document.getElementById('progressBar');
  const progressPercent = document.getElementById('progressPercent');
  const progressSpeed = document.getElementById('progressSpeed');
  const progressETA = document.getElementById('progressETA');
  const doneSection = document.getElementById('doneSection');
  
  const btnOpenFolder = document.getElementById('btnOpenFolder');
  const btnOpenFolderHist = document.getElementById('btnOpenFolderHist');
  const btnNewDownload = document.getElementById('btnNewDownload');
  const btnSelectFolder = document.getElementById('btnSelectFolder');
  const settingFolderPath = document.getElementById('settingFolderPath');

  let currentUrl = '';

  // Get current download folder
  try {
    const defaultDir = await GetOutputDir();
    if (settingFolderPath) settingFolderPath.textContent = defaultDir;
  } catch (e) {
    console.log(e);
  }

  // Paste from clipboard
  btnPaste?.addEventListener('click', async () => {
    try {
      if (navigator.clipboard) {
        const text = await navigator.clipboard.readText();
        if (text) {
          urlInput.value = text;
          fetchVideo(text);
        }
      }
    } catch (e) {
      console.log('Clipboard fallback', e);
    }
  });

  // Fetch Video Info Action
  btnFetch.addEventListener('click', () => {
    const url = urlInput.value.trim();
    if (url) {
      fetchVideo(url);
    } else {
      setStatus('⚠️ Vui lòng nhập link YouTube URL.', 'error');
    }
  });

  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnFetch.click();
  });

  async function fetchVideo(url) {
    currentUrl = url;
    btnFetch.disabled = true;
    setStatus('🔍 Đang gọi Go backend (yt-dlp --dump-json)...', 'info');
    hideResults();

    try {
      const info = await GetVideoInfo(url);
      videoThumb.src = info.thumbnail || 'https://via.placeholder.com/260x146';
      videoTitle.textContent = info.title || 'Unknown Title';
      videoChannel.textContent = info.channel || 'YouTube';
      videoDuration.textContent = info.duration_string || formatDuration(info.duration);
      
      videoCard.classList.remove('hidden');
      setStatus('✅ Đã tải thông tin video thành công!', 'success');
    } catch (err) {
      setStatus(`❌ Lỗi: ${err}`, 'error');
    } finally {
      btnFetch.disabled = false;
    }
  }

  // Download Video Action
  btnDownload.addEventListener('click', async () => {
    if (!currentUrl) return;

    btnDownload.disabled = true;
    btnFetch.disabled = true;
    doneSection.classList.add('hidden');
    progressSection.classList.remove('hidden');
    progressBar.style.width = '0%';
    progressPercent.textContent = '0%';
    setStatus('⏳ Go subprocess đang tải xuống...', 'info');

    try {
      await DownloadVideo(currentUrl, selQuality.value);
    } catch (err) {
      setStatus(`❌ Lỗi tải xuống: ${err}`, 'error');
      progressSection.classList.add('hidden');
    } finally {
      btnDownload.disabled = false;
      btnFetch.disabled = false;
    }
  });

  // Go Event Listeners
  EventsOn('download-progress', (data) => {
    if (data.percent) {
      const pct = parseFloat(data.percent);
      progressBar.style.width = `${Math.min(pct, 100)}%`;
      progressPercent.textContent = `${data.percent}%`;
    }
    if (data.speed) progressSpeed.innerHTML = `<i class="fa-solid fa-gauge-high"></i> ${data.speed}`;
    if (data.eta) progressETA.innerHTML = `<i class="fa-solid fa-clock"></i> ETA: ${data.eta}`;
  });

  EventsOn('download-complete', () => {
    progressBar.style.width = '100%';
    progressPercent.textContent = '100%';
    progressSection.classList.add('hidden');
    doneSection.classList.remove('hidden');
    setStatus('🎉 Tải xuống hoàn tất! Đã lưu vào thư mục Downloads.', 'success');
  });

  // Open Folder & Settings Action
  btnOpenFolder?.addEventListener('click', () => OpenFolder());
  btnOpenFolderHist?.addEventListener('click', () => OpenFolder());

  btnSelectFolder?.addEventListener('click', async () => {
    try {
      const newPath = await SelectFolder();
      if (newPath && settingFolderPath) {
        settingFolderPath.textContent = newPath;
      }
    } catch (e) {
      console.log(e);
    }
  });

  btnNewDownload?.addEventListener('click', () => {
    urlInput.value = '';
    currentUrl = '';
    hideResults();
    setStatus('', '');
    urlInput.focus();
  });

  function setStatus(msg, type) {
    if (!msg) {
      statusBanner.classList.add('hidden');
      return;
    }
    statusMessage.textContent = msg;
    statusBanner.className = `status-banner ${type}`;
    if (type === 'info') {
      statusIcon.className = 'fa-solid fa-spinner fa-spin';
    } else if (type === 'success') {
      statusIcon.className = 'fa-solid fa-circle-check';
    } else {
      statusIcon.className = 'fa-solid fa-circle-exclamation';
    }
    statusBanner.classList.remove('hidden');
  }

  function hideResults() {
    videoCard.classList.add('hidden');
    progressSection.classList.add('hidden');
    doneSection.classList.add('hidden');
  }

  function formatDuration(secs) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
});
