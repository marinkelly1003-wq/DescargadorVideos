import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

interface VideoInfo {
  id: string;
  title: string;
  thumbnail?: string;
  duration?: number;
  uploader?: string;
  url: string;
  views?: number;
  playlist_title?: string;
}

interface DownloadItem {
  id: string;
  title: string;
  thumbnail: string;
  url: string;
  percent: number;
  size: string;
  speed: string;
  eta: string;
  status: "pending" | "downloading" | "completed" | "error";
  error?: string;
  format: "video" | "audio";
}

function App() {
  const [activeTab, setActiveTab] = useState<"search" | "downloads" | "settings">("search");
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [videos, setVideos] = useState<VideoInfo[]>([]);
  const [downloadQueue, setDownloadQueue] = useState<DownloadItem[]>([]);
  const [downloadDir, setDownloadDir] = useState("");
  
  // Modal State for Downloading
  const [selectedVideo, setSelectedVideo] = useState<VideoInfo | null>(null);
  const [formatType, setFormatType] = useState<"video" | "audio">("video");
  const [isPlaylist, setIsPlaylist] = useState(false);

  // Load download directory on mount
  useEffect(() => {
    async function loadDir() {
      try {
        const dir: string = await invoke("get_download_directory");
        setDownloadDir(dir);
      } catch (err) {
        console.error("Error al obtener directorio de descargas", err);
      }
    }
    loadDir();
  }, []);

  // Listen to download progress events from Rust
  useEffect(() => {
    const unlisten = listen("download-progress", (event) => {
      const payload = event.payload as {
        task_id: string;
        percent: number;
        size: string;
        speed: string;
        eta: string;
        status: string;
        error: string | null;
      };

      setDownloadQueue((prev) =>
        prev.map((item) => {
          if (item.id === payload.task_id) {
            return {
              ...item,
              percent: payload.percent,
              size: payload.size,
              speed: payload.speed,
              eta: payload.eta,
              status: payload.status as any,
              error: payload.error || undefined,
            };
          }
          return item;
        })
      );
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Format Helper Functions
  function formatDuration(sec: number | undefined): string {
    if (!sec) return "0:00";
    const hrs = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const secs = Math.floor(sec % 60);
    if (hrs > 0) {
      return `${hrs}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
    }
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  }

  function formatViews(num: number | undefined): string {
    if (!num) return "";
    if (num >= 1e6) return `${(num / 1e6).toFixed(1)}M vistas`;
    if (num >= 1e3) return `${(num / 1e3).toFixed(1)}k vistas`;
    return `${num} vistas`;
  }

  // Handle Search or URL Submit
  async function handleSearchOrUrl(e: React.FormEvent) {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    setLoading(true);
    setVideos([]);
    
    // Check if it's a link
    const isUrl = searchQuery.startsWith("http://") || searchQuery.startsWith("https://");

    try {
      if (isUrl) {
        const results: VideoInfo[] = await invoke("get_video_info", { url: searchQuery.trim() });
        setVideos(results);
      } else {
        const results: VideoInfo[] = await invoke("search_videos", { query: searchQuery.trim() });
        setVideos(results);
      }
    } catch (err) {
      alert(typeof err === "string" ? err : "Ocurrió un error al buscar o recuperar información del video");
    } finally {
      setLoading(false);
    }
  }

  // Open download configuration modal
  function openConfigModal(video: VideoInfo, isPlaylistOption: boolean = false) {
    setSelectedVideo(video);
    setIsPlaylist(isPlaylistOption);
    setFormatType("video");
  }

  // Trigger download command in Rust
  async function startDownload() {
    if (!selectedVideo) return;

    // If it's a playlist we will queue all items, otherwise just the single item
    const videosToDownload = isPlaylist 
      ? videos 
      : [selectedVideo];

    for (const video of videosToDownload) {
      const taskId = `${video.id}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
      
      const newDownload: DownloadItem = {
        id: taskId,
        title: video.title,
        thumbnail: video.thumbnail || "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=200",
        url: video.url,
        percent: 0,
        size: "",
        speed: "",
        eta: "",
        status: "pending",
        format: formatType,
      };

      setDownloadQueue((prev) => [newDownload, ...prev]);

      try {
        await invoke("download_video", {
          url: video.url,
          outputDir: downloadDir,
          formatType: formatType,
          taskId: taskId,
        });
      } catch (err) {
        setDownloadQueue((prev) =>
          prev.map((item) =>
            item.id === taskId
              ? { ...item, status: "error", error: typeof err === "string" ? err : "No se pudo iniciar la descarga" }
              : item
          )
        );
      }
    }

    setSelectedVideo(null);
    setActiveTab("downloads");
  }

  // Open directory in file explorer
  async function handleOpenFolder() {
    try {
      await invoke("open_folder", { path: downloadDir });
    } catch (err) {
      alert(typeof err === "string" ? err : "No se pudo abrir el directorio");
    }
  }

  return (
    <div className="app-container">
      {/* Sidebar Navigation */}
      <nav className="sidebar">
        <div className="logo-container">
          <div className="logo-icon">
            <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{color: '#fff'}}>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </div>
          <span className="logo-text">FlowDL</span>
        </div>

        <div className="nav-links">
          <div className={`nav-item ${activeTab === "search" ? "active" : ""}`} onClick={() => setActiveTab("search")}>
            <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            Buscar / Enlaces
          </div>

          <div className={`nav-item ${activeTab === "downloads" ? "active" : ""}`} onClick={() => setActiveTab("downloads")}>
            <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Descargas
            {downloadQueue.some((item) => item.status === "downloading") && (
              <span style={{ marginLeft: "auto", width: "8px", height: "8px", background: "var(--accent-purple)", borderRadius: "50%", boxShadow: "var(--shadow-glow)" }}></span>
            )}
          </div>

          <div className={`nav-item ${activeTab === "settings" ? "active" : ""}`} onClick={() => setActiveTab("settings")}>
            <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            Ajustes
          </div>
        </div>

        <div className="sidebar-footer">
          FlowDL v0.1.0
        </div>
      </nav>

      {/* Main Panel Content */}
      <main className="main-content">
        {activeTab === "search" && (
          <>
            <h1>Descargar Videos</h1>
            <p className="subtitle">Introduce un enlace de YouTube/Playlists o busca videos directamente.</p>

            <form onSubmit={handleSearchOrUrl} className="search-container">
              <div className="input-wrapper">
                <input
                  type="text"
                  placeholder="Enlace del video/lista o términos de búsqueda..."
                  className="search-input"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <button type="submit" className="btn-primary" disabled={loading}>
                {loading ? (
                  <span>Buscando...</span>
                ) : (
                  <>
                    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{width: 18, height: 18}}>
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    Buscar / Analizar
                  </>
                )}
              </button>
            </form>

            {loading && (
              <div className="spinner-container">
                <div className="spinner"></div>
                <p style={{ color: "var(--text-secondary)", fontWeight: 500 }}>Procesando información con yt-dlp...</p>
              </div>
            )}

            {!loading && videos.length > 0 && (
              <div>
                {videos[0].playlist_title && (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "rgba(139, 92, 246, 0.1)", border: "1px solid var(--border-color-active)", padding: "1rem 1.5rem", borderRadius: "12px", marginBottom: "1.5rem" }}>
                    <div>
                      <h3 style={{ fontSize: "1.1rem" }}>Lista de reproducción: {videos[0].playlist_title}</h3>
                      <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>{videos.length} videos encontrados</p>
                    </div>
                    <button className="btn-primary" onClick={() => openConfigModal(videos[0], true)}>
                      Descargar Playlist Completa
                    </button>
                  </div>
                )}

                <div className="video-grid">
                  {videos.map((video) => (
                    <div key={video.id} className="video-card">
                      <div className="thumbnail-container">
                        <img
                          src={video.thumbnail || "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=400"}
                          alt={video.title}
                          className="thumbnail"
                          onError={(e) => {
                            e.currentTarget.src = "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=400";
                          }}
                        />
                        <span className="duration-badge">{formatDuration(video.duration)}</span>
                      </div>
                      <div className="video-details">
                        <h3 className="video-title" title={video.title}>
                          {video.title}
                        </h3>
                        <p className="video-channel">{video.uploader || "Desconocido"}</p>
                        {video.views !== undefined && (
                          <p style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                            {formatViews(video.views)}
                          </p>
                        )}
                        <div className="card-actions">
                          <button className="btn-primary" style={{ padding: "0.5rem" }} onClick={() => openConfigModal(video, false)}>
                            Descargar
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {activeTab === "downloads" && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "2rem" }}>
              <div>
                <h1>Cola de Descargas</h1>
                <p className="subtitle">Monitorea y gestiona tus descargas actuales y completadas.</p>
              </div>
              <button className="btn-secondary" onClick={handleOpenFolder}>
                <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                Abrir Carpeta de Descargas
              </button>
            </div>

            <div className="downloads-container">
              {downloadQueue.length === 0 ? (
                <div style={{ textAlign: "center", padding: "4rem", border: "2px dashed var(--border-color)", borderRadius: "16px", color: "var(--text-secondary)" }}>
                  <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 48, height: 48, marginBottom: "1rem", color: "var(--text-muted)" }}>
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  <p style={{ fontWeight: 600, fontSize: "1.1rem" }}>No hay descargas activas o completadas</p>
                  <p style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>Busca videos o introduce un enlace para comenzar.</p>
                </div>
              ) : (
                downloadQueue.map((item) => (
                  <div key={item.id} className="download-item">
                    <img src={item.thumbnail} alt={item.title} className="download-thumb" />
                    <div className="download-info">
                      <div className="download-title-row">
                        <span className="download-title" title={item.title}>
                          {item.title}
                        </span>
                        <span className={`status-badge ${item.status}`}>{item.status}</span>
                      </div>

                      {item.status === "downloading" && (
                        <div className="download-meta">
                          <span>{item.percent.toFixed(1)}%</span>
                          <span>•</span>
                          <span>{item.size}</span>
                          <span>•</span>
                          <span>{item.speed}</span>
                          <span>•</span>
                          <span>ETA: {item.eta}</span>
                        </div>
                      )}

                      {item.status === "completed" && (
                        <div className="download-meta" style={{ color: "#34d399" }}>
                          Descarga completada con éxito.
                        </div>
                      )}

                      {item.status === "error" && (
                        <div className="download-meta" style={{ color: "#f87171" }}>
                          Error: {item.error || "Fallo inesperado"}
                        </div>
                      )}

                      {item.status === "pending" && (
                        <div className="download-meta">
                          Esperando en la cola de descarga...
                        </div>
                      )}

                      <div className="progress-container">
                        <div
                          className={`progress-bar ${item.status === "completed" ? "completed" : item.status === "error" ? "error" : ""}`}
                          style={{ width: `${item.percent}%` }}
                        ></div>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        )}

        {activeTab === "settings" && (
          <>
            <h1>Ajustes de FlowDL</h1>
            <p className="subtitle">Personaliza tu experiencia de descarga y carpetas de destino.</p>

            <div className="settings-container">
              <div className="settings-group">
                <span className="settings-label">Carpeta de Destino</span>
                <div className="path-input-group">
                  <input
                    type="text"
                    className="search-input"
                    value={downloadDir}
                    onChange={(e) => setDownloadDir(e.target.value)}
                    style={{ padding: "0.75rem 1rem" }}
                  />
                  <button className="btn-secondary" onClick={handleOpenFolder}>
                    Abrir Carpeta
                  </button>
                </div>
                <p style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                  Aquí es donde se guardarán todos los videos y archivos de audio descargados.
                </p>
              </div>

              <div className="info-box">
                <strong>Información de Dependencias:</strong>
                <p style={{ marginTop: "0.5rem" }}>
                  Esta aplicación utiliza <strong>yt-dlp</strong> y <strong>ffmpeg</strong> instalados localmente en su sistema para procesar, descargar y convertir audio/video de la mejor manera y calidad posible.
                </p>
              </div>
            </div>
          </>
        )}
      </main>

      {/* Download Option Modal Dialog */}
      {selectedVideo && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <span className="modal-title">Configuración de Descarga</span>
              <button className="modal-close" onClick={() => setSelectedVideo(null)}>
                <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <div className="modal-body">
              <p style={{ fontSize: "0.9rem", color: "var(--text-secondary)", marginBottom: "0.5rem" }}>
                {isPlaylist ? `Vas a descargar toda la playlist:` : `Vas a descargar el video:`}
                <strong style={{ display: "block", color: "var(--text-primary)", marginTop: "0.25rem" }}>
                  {selectedVideo.title}
                </strong>
              </p>

              <div className="options-group">
                <span className="options-label">Formato de Descarga</span>
                
                <div className={`format-option ${formatType === "video" ? "selected" : ""}`} onClick={() => setFormatType("video")}>
                  <input
                    type="radio"
                    className="format-radio"
                    checked={formatType === "video"}
                    onChange={() => setFormatType("video")}
                  />
                  <div className="format-details">
                    <span className="format-name">Video (Mejor Calidad)</span>
                    <span className="format-desc">MP4/MKV con la resolución más alta y audio fusionado</span>
                  </div>
                </div>

                <div className={`format-option ${formatType === "audio" ? "selected" : ""}`} onClick={() => setFormatType("audio")}>
                  <input
                    type="radio"
                    className="format-radio"
                    checked={formatType === "audio"}
                    onChange={() => setFormatType("audio")}
                  />
                  <div className="format-details">
                    <span className="format-name">Solo Audio (MP3)</span>
                    <span className="format-desc">Extrae y convierte el audio del video a máxima calidad (.mp3)</span>
                  </div>
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end", marginTop: "1rem" }}>
              <button className="btn-secondary" onClick={() => setSelectedVideo(null)}>
                Cancelar
              </button>
              <button className="btn-primary" onClick={startDownload}>
                Comenzar Descarga
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
