/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useRef, useEffect, useCallback } from "react";
import Icon from "@/components/ui/icon";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Channel {
  id: string;
  name: string;
  url: string;
  logo?: string;
  group?: string;
}

interface Playlist {
  id: string;
  name: string;
  url: string;
  channels: Channel[];
  addedAt: Date;
}

type TabType = "channels" | "playlists" | "favorites";

// ─── M3U Parser ──────────────────────────────────────────────────────────────

function parseM3U(content: string): Channel[] {
  const lines = content.split("\n").map((l) => l.trim());
  const channels: Channel[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith("#EXTINF")) {
      const info = lines[i];
      const url = lines[i + 1] || "";
      if (url && !url.startsWith("#")) {
        const nameMatch = info.match(/,(.+)$/);
        const logoMatch = info.match(/tvg-logo="([^"]+)"/);
        const groupMatch = info.match(/group-title="([^"]+)"/);
        channels.push({
          id: `ch_${Date.now()}_${channels.length}_${Math.random()}`,
          name: nameMatch?.[1]?.trim() || "Без названия",
          url,
          logo: logoMatch?.[1],
          group: groupMatch?.[1] || "Без группы",
        });
        i += 2;
        continue;
      }
    }
    i++;
  }
  return channels;
}

// ─── Demo Channels ────────────────────────────────────────────────────────────

const DEMO_CHANNELS: Channel[] = [
  { id: "demo1", name: "MUX Test Stream", url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8", group: "Demo" },
  { id: "demo2", name: "Big Buck Bunny", url: "https://storage.googleapis.com/shaka-demo-assets/bbb-dark-truths-hls/hls/main.m3u8", group: "Demo" },
  { id: "demo3", name: "Tears of Steel", url: "https://storage.googleapis.com/shaka-demo-assets/tos-surround/hls/main.m3u8", group: "Demo" },
];

// ─── Group helper ─────────────────────────────────────────────────────────────

function groupChannels(channels: Channel[]): Record<string, Channel[]> {
  return channels.reduce((acc, ch) => {
    const g = ch.group || "Без группы";
    if (!acc[g]) acc[g] = [];
    acc[g].push(ch);
    return acc;
  }, {} as Record<string, Channel[]>);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function Index() {
  const videoRef = useRef<HTMLVideoElement>(null);
   
  const hlsRef = useRef<Record<string, unknown> | null>(null);
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [allChannels, setAllChannels] = useState<Channel[]>(DEMO_CHANNELS);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  const [tab, setTab] = useState<TabType>("channels");
  const [search, setSearch] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [showAddPlaylist, setShowAddPlaylist] = useState(false);
  const [newPlaylistUrl, setNewPlaylistUrl] = useState("");
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [isAddingPlaylist, setIsAddingPlaylist] = useState(false);
  const [addError, setAddError] = useState("");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showVolumeSlider, setShowVolumeSlider] = useState(false);

  // ── HLS loader ──────────────────────────────────────────────────────────────
  const tryHls = useCallback((url: string, video: HTMLVideoElement) => {
    const Hls = (window as any).Hls;
    if (Hls && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: false });
      hlsRef.current = hls;
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setIsLoading(false);
        video.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_: any, data: any) => {
        if (data.fatal) {
          setPlayerError("Ошибка загрузки потока");
          setIsLoading(false);
        }
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      video.load();
      video.play().catch(() => {});
      setIsLoading(false);
    } else {
      setPlayerError("HLS не поддерживается в этом браузере");
      setIsLoading(false);
    }
  }, []);

  const loadStream = useCallback(async (url: string) => {
    const video = videoRef.current;
    if (!video) return;
    setPlayerError(null);
    setIsLoading(true);
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    const isHls = url.toLowerCase().includes(".m3u8") || url.toLowerCase().includes("m3u8");
    if (isHls) {
      if (!(window as any).Hls) {
        const script = document.createElement("script");
        script.src = "https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js";
        script.onload = () => tryHls(url, video);
        document.head.appendChild(script);
      } else {
        tryHls(url, video);
      }
    } else {
      video.src = url;
      video.load();
      video.play().catch(() => {});
      setIsLoading(false);
    }
  }, [tryHls]);

  const playChannel = useCallback((ch: Channel) => {
    setActiveChannel(ch);
    loadStream(ch.url);
  }, [loadStream]);

  // ── Video events ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onWaiting = () => setIsLoading(true);
    const onCanPlay = () => setIsLoading(false);
    const onTimeUpdate = () => { setCurrentTime(v.currentTime); setDuration(v.duration || 0); };
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("waiting", onWaiting);
    v.addEventListener("canplay", onCanPlay);
    v.addEventListener("timeupdate", onTimeUpdate);
    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("waiting", onWaiting);
      v.removeEventListener("canplay", onCanPlay);
      v.removeEventListener("timeupdate", onTimeUpdate);
    };
  }, []);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  // ── Controls auto-hide ────────────────────────────────────────────────────────
  const resetControlsTimer = useCallback(() => {
    setShowControls(true);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => setShowControls(false), 3500);
  }, []);

  // ── Player controls ───────────────────────────────────────────────────────────
  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {}); else v.pause();
  };
  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setIsMuted(v.muted);
  };
  const changeVolume = (val: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = val; setVolume(val); setIsMuted(val === 0);
  };
  const toggleFullscreen = () => {
    const el = playerContainerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) el.requestFullscreen().then(() => setIsFullscreen(true));
    else document.exitFullscreen().then(() => setIsFullscreen(false));
  };
  const seekTo = (e: React.MouseEvent<HTMLDivElement>) => {
    const v = videoRef.current;
    if (!v || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    v.currentTime = ((e.clientX - rect.left) / rect.width) * duration;
  };
  const formatTime = (sec: number) => {
    if (!sec || isNaN(sec)) return "LIVE";
    return `${Math.floor(sec / 60)}:${Math.floor(sec % 60).toString().padStart(2, "0")}`;
  };

  // ── Favorites ─────────────────────────────────────────────────────────────────
  const toggleFavorite = (id: string) =>
    setFavorites((prev) => prev.includes(id) ? prev.filter((f) => f !== id) : [...prev, id]);

  // ── Playlist management ───────────────────────────────────────────────────────
  const addPlaylistFromUrl = async () => {
    if (!newPlaylistUrl.trim()) { setAddError("Введите URL плейлиста"); return; }
    setIsAddingPlaylist(true); setAddError("");
    try {
      const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(newPlaylistUrl)}`;
      const res = await fetch(proxyUrl);
      if (!res.ok) throw new Error("Ошибка загрузки файла");
      const text = await res.text();
      if (!text.includes("#EXTM3U") && !text.includes("#EXTINF")) throw new Error("Файл не является M3U плейлистом");
      const channels = parseM3U(text);
      if (channels.length === 0) throw new Error("Каналы не найдены в плейлисте");
      const playlist: Playlist = {
        id: `pl_${Date.now()}`,
        name: newPlaylistName.trim() || `Плейлист ${playlists.length + 1}`,
        url: newPlaylistUrl,
        channels,
        addedAt: new Date(),
      };
      setPlaylists((prev) => [...prev, playlist]);
      setAllChannels((prev) => {
        const ids = new Set(prev.map((c) => c.id));
        return [...prev, ...channels.filter((c) => !ids.has(c.id))];
      });
      setShowAddPlaylist(false);
      setNewPlaylistUrl(""); setNewPlaylistName("");
      setTab("channels");
    } catch (err: any) {
      setAddError(err.message || "Не удалось загрузить плейлист");
    } finally {
      setIsAddingPlaylist(false);
    }
  };

  const addPlaylistFromFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      try {
        const channels = parseM3U(text);
        const playlist: Playlist = {
          id: `pl_${Date.now()}`,
          name: file.name.replace(/\.m3u8?$/, ""),
          url: "local://" + file.name,
          channels,
          addedAt: new Date(),
        };
        setPlaylists((prev) => [...prev, playlist]);
        setAllChannels((prev) => {
          const ids = new Set(prev.map((c) => c.id));
          return [...prev, ...channels.filter((c) => !ids.has(c.id))];
        });
        setShowAddPlaylist(false); setTab("channels");
      } catch { setAddError("Ошибка чтения файла"); }
    };
    reader.readAsText(file);
  };

  const removePlaylist = (id: string) => {
    const pl = playlists.find((p) => p.id === id);
    if (!pl) return;
    const ids = new Set(pl.channels.map((c) => c.id));
    setPlaylists((prev) => prev.filter((p) => p.id !== id));
    setAllChannels((prev) => prev.filter((c) => !ids.has(c.id) || DEMO_CHANNELS.find(d => d.id === c.id)));
  };

  // ── Filtered list ─────────────────────────────────────────────────────────────
  const displayChannels =
    tab === "favorites"
      ? allChannels.filter((c) => favorites.includes(c.id))
      : allChannels.filter((c) => !search || c.name.toLowerCase().includes(search.toLowerCase()));
  const grouped = groupChannels(displayChannels);

  const toggleGroup = (g: string) =>
    setExpandedGroups((prev) => ({ ...prev, [g]: prev[g] === false ? true : false }));

  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background font-exo bg-grid flex flex-col overflow-hidden select-none">

      {/* Ambient orbs */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
        <div className="absolute w-96 h-96 rounded-full blur-3xl opacity-[0.07]"
          style={{ background: "radial-gradient(circle, #00d4ff, transparent)", top: "-8%", left: "-8%" }} />
        <div className="absolute w-80 h-80 rounded-full blur-3xl opacity-[0.06]"
          style={{ background: "radial-gradient(circle, #9b59ff, transparent)", bottom: "10%", right: "-5%" }} />
        <div className="absolute w-64 h-64 rounded-full blur-3xl opacity-[0.05]"
          style={{ background: "radial-gradient(circle, #ff3d9a, transparent)", top: "45%", left: "35%" }} />
      </div>

      {/* ── Header ── */}
      <header className="relative z-10 glass border-b border-white/5 px-4 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 animate-pulse-glow"
            style={{ background: "linear-gradient(135deg, #00d4ff22, #9b59ff22)", border: "1px solid rgba(0,212,255,0.3)" }}>
            <Icon name="Tv2" size={18} style={{ color: "#00d4ff" }} />
          </div>
          <div>
            <h1 className="text-base font-bold font-rajdhani tracking-widest uppercase leading-none"
              style={{ color: "#00d4ff", textShadow: "0 0 20px rgba(0,212,255,0.6)" }}>
              IPTV Player
            </h1>
            <p className="text-[10px] text-muted-foreground leading-none mt-0.5 font-rajdhani tracking-wider">
              {allChannels.length} каналов
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {activeChannel && (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
              style={{ background: "rgba(255,0,80,0.12)", border: "1px solid rgba(255,0,80,0.25)" }}>
              <span className="w-1.5 h-1.5 rounded-full live-badge" style={{ background: "#ff3d9a", boxShadow: "0 0 6px #ff3d9a" }} />
              <span className="text-red-400 font-rajdhani tracking-widest text-[10px]">LIVE</span>
            </div>
          )}
          <button onClick={() => setShowAddPlaylist(true)}
            className="neon-glow-btn text-white text-xs font-semibold px-3 py-2 rounded-lg flex items-center gap-1.5">
            <Icon name="Plus" size={14} />
            <span>Плейлист</span>
          </button>
        </div>
      </header>

      {/* ── Body ── */}
      <div className="relative z-10 flex flex-1 overflow-hidden flex-col md:flex-row" style={{ minHeight: 0 }}>

        {/* ─── Video player ─── */}
        <div className="w-full md:flex-1 flex flex-col" style={{ minWidth: 0 }}>
          <div ref={playerContainerRef}
            className="relative bg-black w-full"
            style={{ aspectRatio: "16/9" }}
            onMouseMove={resetControlsTimer}
            onTouchStart={resetControlsTimer}
            onClick={togglePlay}
          >
            <video ref={videoRef} className="w-full h-full object-contain" playsInline />

            {/* Placeholder */}
            {!activeChannel && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black">
                <div className="relative">
                  <div className="w-24 h-24 rounded-2xl flex items-center justify-center"
                    style={{ background: "rgba(0,212,255,0.06)", border: "1px solid rgba(0,212,255,0.15)" }}>
                    <Icon name="Tv2" size={40} style={{ color: "rgba(0,212,255,0.4)" }} />
                  </div>
                  <div className="absolute -inset-2 rounded-3xl blur-xl opacity-20"
                    style={{ background: "radial-gradient(circle, #00d4ff, transparent)" }} />
                </div>
                <div className="text-center space-y-1">
                  <p className="text-white/40 text-sm font-medium">Выберите канал</p>
                  <p className="text-white/20 text-xs">из списка или добавьте плейлист</p>
                </div>
              </div>
            )}

            {/* Spinner */}
            {isLoading && activeChannel && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-12 h-12 rounded-full border-2 border-white/10"
                  style={{ borderTopColor: "#00d4ff", animation: "spin 0.75s linear infinite" }} />
              </div>
            )}

            {/* Error */}
            {playerError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 pointer-events-auto">
                <Icon name="AlertCircle" size={36} className="text-red-400" />
                <p className="text-red-400/90 text-sm font-medium">{playerError}</p>
                <button onClick={(e) => { e.stopPropagation(); if (activeChannel) playChannel(activeChannel); }}
                  className="text-xs px-4 py-2 rounded-lg font-semibold transition-all"
                  style={{ background: "rgba(255,61,61,0.15)", border: "1px solid rgba(255,61,61,0.3)", color: "#ff6b6b" }}>
                  Повторить
                </button>
              </div>
            )}

            {/* Controls */}
            <div className="absolute inset-0 flex flex-col justify-between pointer-events-none transition-opacity duration-500"
              style={{ opacity: showControls || !isPlaying || !activeChannel ? 1 : 0 }}>
              {/* Top: channel name */}
              {activeChannel && (
                <div className="p-3 pointer-events-auto">
                  <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-lg text-xs"
                    style={{ background: "rgba(0,0,0,0.65)", backdropFilter: "blur(12px)", border: "1px solid rgba(255,255,255,0.08)" }}>
                    <span className="w-1.5 h-1.5 rounded-full live-badge" style={{ background: "#ff3d9a", boxShadow: "0 0 5px #ff3d9a" }} />
                    <span className="text-white/85 font-medium">{activeChannel.name}</span>
                    {activeChannel.group && <span className="text-white/35">· {activeChannel.group}</span>}
                  </div>
                </div>
              )}
              <div className="flex-1" />

              {/* Bottom controls */}
              <div className="pointer-events-auto"
                style={{ background: "linear-gradient(to top, rgba(0,0,0,0.9) 0%, transparent 100%)", padding: "32px 12px 12px" }}>
                {/* Progress */}
                <div className="progress-bar mb-3 cursor-pointer" onClick={seekTo}>
                  <div className="progress-fill" style={{ width: `${progressPct}%` }} />
                </div>

                <div className="flex items-center gap-2">
                  {/* Prev */}
                  <button className="text-white/60 hover:text-white transition-colors p-1"
                    onClick={(e) => { e.stopPropagation(); if (!activeChannel) return; const idx = allChannels.findIndex(c => c.id === activeChannel.id); if (idx > 0) playChannel(allChannels[idx - 1]); }}>
                    <Icon name="SkipBack" size={17} />
                  </button>

                  {/* Play */}
                  <button onClick={(e) => { e.stopPropagation(); togglePlay(); }}
                    className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-all active:scale-90"
                    style={{ background: "linear-gradient(135deg, #00d4ff, #9b59ff)", boxShadow: "0 0 18px rgba(0,212,255,0.5)" }}>
                    <Icon name={isPlaying ? "Pause" : "Play"} size={18} className="text-white" />
                  </button>

                  {/* Next */}
                  <button className="text-white/60 hover:text-white transition-colors p-1"
                    onClick={(e) => { e.stopPropagation(); if (!activeChannel) return; const idx = allChannels.findIndex(c => c.id === activeChannel.id); if (idx < allChannels.length - 1) playChannel(allChannels[idx + 1]); }}>
                    <Icon name="SkipForward" size={17} />
                  </button>

                  {/* Time */}
                  <span className="text-white/50 text-xs font-rajdhani tracking-wider ml-1">
                    {formatTime(currentTime)}{duration > 0 && ` / ${formatTime(duration)}`}
                  </span>

                  <div className="flex-1" />

                  {/* Volume */}
                  <div className="flex items-center gap-2" onMouseEnter={() => setShowVolumeSlider(true)} onMouseLeave={() => setShowVolumeSlider(false)}>
                    <button className="text-white/60 hover:text-white transition-colors p-1" onClick={(e) => { e.stopPropagation(); toggleMute(); }}>
                      <Icon name={isMuted || volume === 0 ? "VolumeX" : volume < 0.5 ? "Volume1" : "Volume2"} size={17} />
                    </button>
                    <div className={`transition-all overflow-hidden ${showVolumeSlider ? "w-20 opacity-100" : "w-0 opacity-0"}`}>
                      <input type="range" min={0} max={1} step={0.05} value={isMuted ? 0 : volume}
                        onChange={(e) => changeVolume(Number(e.target.value))}
                        onClick={(e) => e.stopPropagation()}
                        className="volume-slider w-full" />
                    </div>
                  </div>

                  {/* Fav */}
                  {activeChannel && (
                    <button className="p-1 transition-colors" onClick={(e) => { e.stopPropagation(); toggleFavorite(activeChannel.id); }}
                      style={{ color: favorites.includes(activeChannel.id) ? "#ff3d9a" : "rgba(255,255,255,0.5)" }}>
                      <Icon name="Heart" size={17} />
                    </button>
                  )}

                  {/* Fullscreen */}
                  <button className="text-white/60 hover:text-white transition-colors p-1" onClick={(e) => { e.stopPropagation(); toggleFullscreen(); }}>
                    <Icon name={isFullscreen ? "Minimize2" : "Maximize2"} size={17} />
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Channel info strip */}
          {activeChannel && (
            <div className="glass border-t border-white/5 px-4 py-3 flex items-center gap-3 animate-fade-in shrink-0">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 overflow-hidden"
                style={{ background: "rgba(0,212,255,0.08)", border: "1px solid rgba(0,212,255,0.2)" }}>
                {activeChannel.logo
                  ? <img src={activeChannel.logo} alt="" className="w-full h-full object-contain" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
                  : <Icon name="Tv2" size={18} style={{ color: "#00d4ff" }} />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm truncate text-white/90">{activeChannel.name}</p>
                <p className="text-xs text-muted-foreground">{activeChannel.group}</p>
              </div>
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs shrink-0"
                style={{ background: "rgba(0,255,136,0.08)", border: "1px solid rgba(0,255,136,0.2)" }}>
                <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "#00ff88", boxShadow: "0 0 5px #00ff88" }} />
                <span style={{ color: "#00ff88" }} className="font-rajdhani tracking-wider text-[10px] font-semibold">ЭФИР</span>
              </div>
            </div>
          )}
        </div>

        {/* ─── Sidebar ─── */}
        <div className="md:w-80 flex flex-col glass border-t md:border-t-0 md:border-l border-white/5 shrink-0"
          style={{ height: "var(--sidebar-h, 45vh)", maxHeight: 700 }}>

          {/* Tabs */}
          <div className="flex border-b border-white/5 shrink-0">
            {([
              { key: "channels" as TabType, icon: "List", label: "Каналы" },
              { key: "favorites" as TabType, icon: "Heart", label: "Избранное" },
              { key: "playlists" as TabType, icon: "FolderOpen", label: "Листы" },
            ]).map(({ key, icon, label }) => (
              <button key={key} onClick={() => setTab(key)}
                className="flex-1 flex flex-col items-center py-3 gap-1 text-[11px] font-semibold transition-all relative"
                style={{ color: tab === key ? "#00d4ff" : "rgba(255,255,255,0.35)" }}>
                <Icon name={icon as any} size={15} />
                {label}
                {tab === key && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full"
                    style={{ background: "linear-gradient(90deg, #00d4ff, #9b59ff)" }} />
                )}
              </button>
            ))}
          </div>

          {/* Search */}
          {(tab === "channels" || tab === "favorites") && (
            <div className="px-3 py-2.5 shrink-0">
              <div className="flex items-center gap-2 px-3 py-2 rounded-xl"
                style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)" }}>
                <Icon name="Search" size={13} className="text-muted-foreground shrink-0" />
                <input value={search} onChange={(e) => setSearch(e.target.value)}
                  placeholder="Поиск канала..."
                  className="flex-1 bg-transparent text-sm outline-none text-white/80 placeholder:text-muted-foreground/50" />
                {search && (
                  <button onClick={() => setSearch("")}>
                    <Icon name="X" size={12} className="text-muted-foreground" />
                  </button>
                )}
              </div>
            </div>
          )}

          {/* List */}
          <div className="flex-1 overflow-y-auto">

            {/* Channels / Favorites */}
            {(tab === "channels" || tab === "favorites") && (
              <div className="pb-4">
                {Object.keys(grouped).length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-14 gap-3">
                    <Icon name={tab === "favorites" ? "Heart" : "Tv2"} size={28} className="text-muted-foreground/25" />
                    <p className="text-muted-foreground/50 text-xs text-center px-8 leading-relaxed">
                      {tab === "favorites" ? "Нет избранных каналов.\nНажмите ♥ рядом с каналом" : search ? "Ничего не найдено" : "Добавьте плейлист, чтобы\nувидеть каналы"}
                    </p>
                  </div>
                ) : (
                  Object.entries(grouped).map(([group, channels]) => (
                    <div key={group}>
                      <button onClick={() => toggleGroup(group)}
                        className="w-full flex items-center justify-between px-4 py-2 hover:bg-white/3 transition-colors">
                        <span className="text-[10px] font-bold uppercase tracking-widest font-rajdhani" style={{ color: "#9b59ff" }}>
                          {group}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] text-muted-foreground/50 font-rajdhani">{channels.length}</span>
                          <Icon name={expandedGroups[group] === false ? "ChevronRight" : "ChevronDown"} size={11} className="text-muted-foreground/50" />
                        </div>
                      </button>

                      {expandedGroups[group] !== false && channels.map((ch) => (
                        <div key={ch.id}
                          className={`channel-card flex items-center gap-3 px-4 py-2.5 cursor-pointer border-l-2 ${activeChannel?.id === ch.id ? "active" : "border-transparent"}`}
                          onClick={() => playChannel(ch)}>
                          <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 overflow-hidden transition-all"
                            style={{
                              background: activeChannel?.id === ch.id ? "rgba(0,212,255,0.15)" : "rgba(255,255,255,0.04)",
                              border: `1px solid ${activeChannel?.id === ch.id ? "rgba(0,212,255,0.35)" : "rgba(255,255,255,0.07)"}`,
                            }}>
                            {ch.logo
                              ? <img src={ch.logo} alt="" className="w-full h-full object-contain" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
                              : <Icon name="Tv2" size={13} style={{ color: activeChannel?.id === ch.id ? "#00d4ff" : "rgba(255,255,255,0.3)" }} />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm truncate leading-tight"
                              style={{ color: activeChannel?.id === ch.id ? "#00d4ff" : "rgba(255,255,255,0.8)", fontWeight: activeChannel?.id === ch.id ? 600 : 400 }}>
                              {ch.name}
                            </p>
                          </div>
                          {activeChannel?.id === ch.id && isPlaying && (
                            <div className="flex gap-0.5 items-end shrink-0">
                              {[1, 2, 3].map((i) => (
                                <div key={i} className="w-0.5 rounded-full"
                                  style={{
                                    height: `${8 + i * 3}px`, background: "#00d4ff",
                                    animation: `pulse ${0.5 + i * 0.15}s ease-in-out infinite alternate`,
                                  }} />
                              ))}
                            </div>
                          )}
                          <button onClick={(e) => { e.stopPropagation(); toggleFavorite(ch.id); }}
                            className="shrink-0 transition-all hover:scale-110 p-1"
                            style={{ color: favorites.includes(ch.id) ? "#ff3d9a" : "rgba(255,255,255,0.18)" }}>
                            <Icon name="Heart" size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  ))
                )}
              </div>
            )}

            {/* Playlists */}
            {tab === "playlists" && (
              <div className="p-3 space-y-2">
                {/* Built-in */}
                <div className="p-3 rounded-xl" style={{ background: "rgba(0,212,255,0.04)", border: "1px solid rgba(0,212,255,0.12)" }}>
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: "rgba(0,212,255,0.1)" }}>
                      <Icon name="Zap" size={16} style={{ color: "#00d4ff" }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-white/90">Demo каналы</p>
                      <p className="text-xs text-muted-foreground">{DEMO_CHANNELS.length} каналов · встроенный</p>
                    </div>
                    <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold font-rajdhani tracking-wider"
                      style={{ background: "rgba(0,212,255,0.1)", color: "#00d4ff", border: "1px solid rgba(0,212,255,0.2)" }}>
                      DEMO
                    </span>
                  </div>
                </div>

                {playlists.map((pl) => (
                  <div key={pl.id} className="p-3 rounded-xl animate-fade-in"
                    style={{ background: "rgba(155,89,255,0.04)", border: "1px solid rgba(155,89,255,0.12)" }}>
                    <div className="flex items-center gap-2.5">
                      <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: "rgba(155,89,255,0.1)" }}>
                        <Icon name="FolderOpen" size={16} style={{ color: "#9b59ff" }} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-white/90 truncate">{pl.name}</p>
                        <p className="text-xs text-muted-foreground">{pl.channels.length} каналов</p>
                      </div>
                      <button onClick={() => removePlaylist(pl.id)} className="text-red-400/40 hover:text-red-400 transition-colors p-1">
                        <Icon name="Trash2" size={14} />
                      </button>
                    </div>
                  </div>
                ))}

                <button onClick={() => setShowAddPlaylist(true)}
                  className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl text-sm font-medium transition-all mt-1"
                  style={{ border: "1px dashed rgba(255,255,255,0.12)", color: "rgba(255,255,255,0.35)" }}
                  onMouseEnter={(e) => { const b = e.currentTarget; b.style.borderColor = "rgba(0,212,255,0.4)"; b.style.color = "#00d4ff"; b.style.background = "rgba(0,212,255,0.04)"; }}
                  onMouseLeave={(e) => { const b = e.currentTarget; b.style.borderColor = "rgba(255,255,255,0.12)"; b.style.color = "rgba(255,255,255,0.35)"; b.style.background = "transparent"; }}>
                  <Icon name="Plus" size={16} />
                  Добавить плейлист
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Add Playlist Modal ── */}
      {showAddPlaylist && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
          style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(10px)" }}
          onClick={(e) => { if (e.target === e.currentTarget) { setShowAddPlaylist(false); setAddError(""); } }}>
          <div className="w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl p-6 animate-slide-up"
            style={{ background: "rgba(10,12,20,0.98)", border: "1px solid rgba(0,212,255,0.18)", boxShadow: "0 0 50px rgba(0,212,255,0.1), 0 -20px 60px rgba(0,0,0,0.5)" }}>

            <div className="flex items-center justify-between mb-5">
              <div>
                <h2 className="text-xl font-bold font-rajdhani tracking-wider" style={{ color: "#00d4ff", textShadow: "0 0 20px rgba(0,212,255,0.5)" }}>
                  Добавить плейлист
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">Поддерживается формат M3U и M3U8</p>
              </div>
              <button onClick={() => { setShowAddPlaylist(false); setAddError(""); }}
                className="w-8 h-8 rounded-xl flex items-center justify-center hover:bg-white/8 transition-colors"
                style={{ border: "1px solid rgba(255,255,255,0.08)" }}>
                <Icon name="X" size={15} className="text-muted-foreground" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground/70 mb-1.5 block font-medium">Название (необязательно)</label>
                <input value={newPlaylistName} onChange={(e) => setNewPlaylistName(e.target.value)}
                  placeholder="Мой плейлист"
                  className="w-full px-4 py-2.5 rounded-xl text-sm outline-none text-white/90 placeholder:text-muted-foreground/40 transition-all"
                  style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = "rgba(0,212,255,0.4)"; e.currentTarget.style.boxShadow = "0 0 12px rgba(0,212,255,0.1)"; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)"; e.currentTarget.style.boxShadow = "none"; }} />
              </div>

              <div>
                <label className="text-xs text-muted-foreground/70 mb-1.5 block font-medium">URL плейлиста</label>
                <input value={newPlaylistUrl} onChange={(e) => setNewPlaylistUrl(e.target.value)}
                  placeholder="https://example.com/playlist.m3u"
                  className="w-full px-4 py-2.5 rounded-xl text-sm outline-none text-white/90 placeholder:text-muted-foreground/40 transition-all"
                  style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = "rgba(0,212,255,0.4)"; e.currentTarget.style.boxShadow = "0 0 12px rgba(0,212,255,0.1)"; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)"; e.currentTarget.style.boxShadow = "none"; }}
                  onKeyDown={(e) => e.key === "Enter" && addPlaylistFromUrl()} />
              </div>

              <div className="flex items-center gap-3 py-0.5">
                <div className="flex-1 h-px" style={{ background: "rgba(255,255,255,0.07)" }} />
                <span className="text-xs text-muted-foreground/40 font-medium">или загрузить файл</span>
                <div className="flex-1 h-px" style={{ background: "rgba(255,255,255,0.07)" }} />
              </div>

              <label className="flex items-center justify-center gap-2 py-3 rounded-xl cursor-pointer transition-all text-sm font-medium"
                style={{ border: "1px dashed rgba(155,89,255,0.25)", color: "rgba(155,89,255,0.6)" }}
                onMouseEnter={(e) => { const l = e.currentTarget; l.style.borderColor = "rgba(155,89,255,0.5)"; l.style.background = "rgba(155,89,255,0.05)"; l.style.color = "#9b59ff"; }}
                onMouseLeave={(e) => { const l = e.currentTarget; l.style.borderColor = "rgba(155,89,255,0.25)"; l.style.background = "transparent"; l.style.color = "rgba(155,89,255,0.6)"; }}>
                <Icon name="Upload" size={16} />
                Загрузить .m3u / .m3u8
                <input type="file" accept=".m3u,.m3u8,text/plain" className="hidden" onChange={addPlaylistFromFile} />
              </label>
            </div>

            {addError && (
              <div className="mt-3 flex items-center gap-2.5 p-3 rounded-xl text-sm"
                style={{ background: "rgba(255,50,50,0.08)", border: "1px solid rgba(255,50,50,0.2)" }}>
                <Icon name="AlertCircle" size={15} className="text-red-400 shrink-0" />
                <span className="text-red-400/90">{addError}</span>
              </div>
            )}

            <button onClick={addPlaylistFromUrl}
              disabled={isAddingPlaylist || !newPlaylistUrl.trim()}
              className="w-full mt-4 py-3.5 rounded-xl font-bold text-sm font-rajdhani tracking-wider uppercase transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                background: isAddingPlaylist || !newPlaylistUrl.trim() ? "rgba(255,255,255,0.06)" : "linear-gradient(135deg, #00d4ff, #9b59ff)",
                color: "white",
                boxShadow: isAddingPlaylist || !newPlaylistUrl.trim() ? "none" : "0 0 25px rgba(0,212,255,0.35)",
              }}>
              {isAddingPlaylist
                ? <span className="flex items-center justify-center gap-2">
                    <span className="w-4 h-4 rounded-full border-2 border-white/20" style={{ borderTopColor: "white", animation: "spin 0.75s linear infinite" }} />
                    Загружаю...
                  </span>
                : "Добавить плейлист"
              }
            </button>
          </div>
        </div>
      )}
    </div>
  );
}