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

type TabType = "channels" | "playlists" | "favorites" | "epg";

// ─── EPG Types ────────────────────────────────────────────────────────────────

interface EpgProgram {
  id: string;
  channelId: string;
  title: string;
  desc?: string;
  start: Date;
  stop: Date;
  category?: string;
}

interface EpgChannel {
  id: string;
  name: string;
  icon?: string;
}

interface EpgData {
  channels: EpgChannel[];
  programs: EpgProgram[];
  loadedAt: Date;
}

// ─── XMLTV Parser ─────────────────────────────────────────────────────────────

function parseXmltvDate(raw: string): Date {
  // format: 20240101120000 +0300
  const s = raw.trim();
  const y = s.slice(0,4), mo = s.slice(4,6), d = s.slice(6,8);
  const h = s.slice(8,10), mi = s.slice(10,12), sec = s.slice(12,14);
  const tz = s.slice(15) || "+0000";
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${sec}${tz}`);
}

function parseXMLTV(xml: string): EpgData {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "application/xml");
  const channels: EpgChannel[] = [];
  const programs: EpgProgram[] = [];

  doc.querySelectorAll("channel").forEach((ch) => {
    const id = ch.getAttribute("id") || "";
    const name = ch.querySelector("display-name")?.textContent || id;
    const icon = ch.querySelector("icon")?.getAttribute("src") || undefined;
    channels.push({ id, name, icon });
  });

  doc.querySelectorAll("programme").forEach((p, i) => {
    const channelId = p.getAttribute("channel") || "";
    const startRaw = p.getAttribute("start") || "";
    const stopRaw = p.getAttribute("stop") || "";
    const title = p.querySelector("title")?.textContent || "Без названия";
    const desc = p.querySelector("desc")?.textContent || undefined;
    const category = p.querySelector("category")?.textContent || undefined;
    try {
      programs.push({
        id: `prg_${i}`,
        channelId,
        title,
        desc,
        category,
        start: parseXmltvDate(startRaw),
        stop: parseXmltvDate(stopRaw),
      });
    } catch { /* skip bad entries */ }
  });

  return { channels, programs, loadedAt: new Date() };
}

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

  // ── EPG state ────────────────────────────────────────────────────────────────
  const [epgData, setEpgData] = useState<EpgData | null>(null);
  const [epgUrl, setEpgUrl] = useState("");
  const [isLoadingEpg, setIsLoadingEpg] = useState(false);
  const [epgError, setEpgError] = useState("");
  const [showEpgInput, setShowEpgInput] = useState(false);
  const [epgSelectedChannel, setEpgSelectedChannel] = useState<string | null>(null);
  const [epgNow, setEpgNow] = useState(() => new Date());
  const [epgSearch, setEpgSearch] = useState("");
  const [epgSearchMode, setEpgSearchMode] = useState(false);

  // Обновляем текущее время каждую минуту для EPG
  useEffect(() => {
    const t = setInterval(() => setEpgNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

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

  // ── EPG loader ───────────────────────────────────────────────────────────────
  const loadEpg = async () => {
    if (!epgUrl.trim()) { setEpgError("Введите URL EPG"); return; }
    setIsLoadingEpg(true); setEpgError("");
    try {
      const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(epgUrl)}`;
      const res = await fetch(proxyUrl);
      if (!res.ok) throw new Error("Ошибка загрузки");
      const text = await res.text();
      if (!text.includes("<tv") && !text.includes("<programme")) throw new Error("Не является XMLTV файлом");
      const data = parseXMLTV(text);
      if (data.programs.length === 0) throw new Error("Программы не найдены");
      setEpgData(data);
      setShowEpgInput(false);
      if (data.channels.length > 0) setEpgSelectedChannel(data.channels[0].id);
    } catch (err: any) {
      setEpgError(err.message || "Не удалось загрузить EPG");
    } finally {
      setIsLoadingEpg(false);
    }
  };

  const getChannelPrograms = (channelId: string): EpgProgram[] => {
    if (!epgData) return [];
    const now = epgNow;
    const todayStart = new Date(now); todayStart.setHours(0,0,0,0);
    const todayEnd = new Date(now); todayEnd.setHours(23,59,59,999);
    return epgData.programs
      .filter(p => p.channelId === channelId && p.stop >= todayStart && p.start <= todayEnd)
      .sort((a, b) => a.start.getTime() - b.start.getTime());
  };

  const isCurrentProgram = (p: EpgProgram) => p.start <= epgNow && p.stop >= epgNow;

  const formatEpgTime = (d: Date) =>
    d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

  const getProgramProgress = (p: EpgProgram): number => {
    if (!isCurrentProgram(p)) return 0;
    const total = p.stop.getTime() - p.start.getTime();
    const elapsed = epgNow.getTime() - p.start.getTime();
    return Math.min(100, Math.max(0, (elapsed / total) * 100));
  };

  // ── EPG ↔ Channel matching ────────────────────────────────────────────────────
  const getEpgIdForChannel = useCallback((ch: Channel): string | null => {
    if (!epgData) return null;
    // 1. Exact match by tvg-id stored in channel.id (from m3u tvg-id)
    if (epgData.channels.find(e => e.id === ch.id)) return ch.id;
    // 2. Fuzzy name match — normalize both sides
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-zа-яё0-9]/gi, "");
    const chNorm = normalize(ch.name);
    const match = epgData.channels.find(e => normalize(e.name) === chNorm);
    if (match) return match.id;
    // 3. Partial match
    const partial = epgData.channels.find(e =>
      normalize(e.name).includes(chNorm) || chNorm.includes(normalize(e.name))
    );
    return partial?.id ?? null;
  }, [epgData]);

  const getNowPlaying = useCallback((ch: Channel): EpgProgram | null => {
    if (!epgData) return null;
    const epgId = getEpgIdForChannel(ch);
    if (!epgId) return null;
    return epgData.programs.find(p => p.channelId === epgId && isCurrentProgram(p)) ?? null;
  }, [epgData, getEpgIdForChannel, isCurrentProgram]);

  // Найти канал плейлиста по EPG-каналу (обратный матчинг)
  const findPlaylistChannelByEpgId = useCallback((epgChannelId: string): Channel | null => {
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-zа-яё0-9]/gi, "");
    const epgCh = epgData?.channels.find(e => e.id === epgChannelId);
    if (!epgCh) return null;
    // Сначала по id
    const byId = allChannels.find(c => c.id === epgChannelId);
    if (byId) return byId;
    // Потом по имени
    const epgNorm = normalize(epgCh.name);
    return allChannels.find(c => normalize(c.name) === epgNorm)
      ?? allChannels.find(c => normalize(c.name).includes(epgNorm) || epgNorm.includes(normalize(c.name)))
      ?? null;
  }, [epgData, allChannels]);

  // ── EPG search ───────────────────────────────────────────────────────────────
  const epgSearchResults = useCallback((): Array<{ program: EpgProgram; channel: EpgChannel }> => {
    if (!epgData || !epgSearch.trim()) return [];
    const q = epgSearch.toLowerCase();
    const results: Array<{ program: EpgProgram; channel: EpgChannel }> = [];
    const chMap = new Map(epgData.channels.map(c => [c.id, c]));
    const todayStart = new Date(epgNow); todayStart.setHours(0,0,0,0);
    const todayEnd = new Date(epgNow); todayEnd.setHours(23,59,59,999);
    for (const p of epgData.programs) {
      if (p.stop < todayStart || p.start > todayEnd) continue;
      if (
        p.title.toLowerCase().includes(q) ||
        (p.desc && p.desc.toLowerCase().includes(q)) ||
        (p.category && p.category.toLowerCase().includes(q))
      ) {
        const ch = chMap.get(p.channelId);
        if (ch) results.push({ program: p, channel: ch });
      }
    }
    return results.sort((a, b) => {
      const aActive = isCurrentProgram(a.program) ? -1 : 1;
      const bActive = isCurrentProgram(b.program) ? -1 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return a.program.start.getTime() - b.program.start.getTime();
    }).slice(0, 50);
  }, [epgData, epgSearch, epgNow, isCurrentProgram]);

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
          {activeChannel && (() => {
            const nowPlaying = getNowPlaying(activeChannel);
            const progress = nowPlaying ? getProgramProgress(nowPlaying) : 0;
            const nextProgram = nowPlaying && epgData
              ? epgData.programs
                  .filter(p => p.channelId === (getEpgIdForChannel(activeChannel) ?? "") && p.start >= nowPlaying.stop)
                  .sort((a, b) => a.start.getTime() - b.start.getTime())[0]
              : null;
            return (
              <div className="glass border-t border-white/5 px-4 py-3 flex flex-col gap-2.5 animate-fade-in shrink-0">
                {/* Top row: logo + name + live badge */}
                <div className="flex items-center gap-3">
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

                {/* Now playing EPG block */}
                {nowPlaying && (
                  <div className="rounded-xl overflow-hidden animate-fade-in"
                    style={{ background: "rgba(0,212,255,0.05)", border: "1px solid rgba(0,212,255,0.15)" }}>
                    <div className="px-3 py-2.5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 mb-0.5">
                            <span className="w-1.5 h-1.5 rounded-full shrink-0 live-badge"
                              style={{ background: "#00d4ff", boxShadow: "0 0 5px #00d4ff" }} />
                            <p className="text-sm font-semibold truncate text-white/95">{nowPlaying.title}</p>
                          </div>
                          {nowPlaying.category && (
                            <span className="inline-block text-[10px] px-1.5 py-0.5 rounded font-medium"
                              style={{ background: "rgba(155,89,255,0.15)", color: "rgba(155,89,255,0.9)" }}>
                              {nowPlaying.category}
                            </span>
                          )}
                          {nowPlaying.desc && (
                            <p className="text-[11px] text-muted-foreground/60 mt-1 line-clamp-2 leading-relaxed">
                              {nowPlaying.desc}
                            </p>
                          )}
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-xs font-rajdhani font-bold" style={{ color: "#00d4ff" }}>
                            {formatEpgTime(nowPlaying.start)}
                          </p>
                          <p className="text-[10px] text-muted-foreground/50 font-rajdhani">
                            до {formatEpgTime(nowPlaying.stop)}
                          </p>
                        </div>
                      </div>
                      {/* Progress bar */}
                      <div className="mt-2.5 h-1 rounded-full overflow-hidden"
                        style={{ background: "rgba(0,212,255,0.1)" }}>
                        <div className="h-full rounded-full"
                          style={{ width: `${progress}%`, background: "linear-gradient(90deg, #00d4ff, #9b59ff)", boxShadow: "0 0 6px rgba(0,212,255,0.6)", transition: "width 0.5s linear" }} />
                      </div>
                    </div>
                    {/* Next program */}
                    {nextProgram && (
                      <div className="px-3 py-2 border-t"
                        style={{ borderColor: "rgba(0,212,255,0.1)", background: "rgba(0,0,0,0.15)" }}>
                        <div className="flex items-center gap-2">
                          <Icon name="ChevronRight" size={11} className="text-muted-foreground/40 shrink-0" />
                          <span className="text-[11px] text-muted-foreground/50 font-rajdhani font-semibold mr-1">
                            {formatEpgTime(nextProgram.start)}
                          </span>
                          <span className="text-[11px] text-white/40 truncate">{nextProgram.title}</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* No EPG hint */}
                {!nowPlaying && epgData && (
                  <p className="text-[11px] text-muted-foreground/30 text-center py-0.5">
                    Программа для этого канала не найдена в EPG
                  </p>
                )}
                {!epgData && (
                  <button onClick={() => setTab("epg")}
                    className="flex items-center gap-1.5 text-[11px] transition-colors self-start"
                    style={{ color: "rgba(0,212,255,0.4)" }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = "#00d4ff")}
                    onMouseLeave={(e) => (e.currentTarget.style.color = "rgba(0,212,255,0.4)")}>
                    <Icon name="CalendarDays" size={12} />
                    Добавить программу передач (EPG)
                  </button>
                )}
              </div>
            );
          })()}
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
              { key: "epg" as TabType, icon: "CalendarDays", label: "EPG" },
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

            {/* EPG */}
            {tab === "epg" && (
              <div className="flex flex-col h-full">
                {/* No EPG loaded */}
                {!epgData && !showEpgInput && (
                  <div className="flex flex-col items-center justify-center py-12 gap-4 px-4">
                    <div className="w-16 h-16 rounded-2xl flex items-center justify-center"
                      style={{ background: "rgba(0,212,255,0.06)", border: "1px solid rgba(0,212,255,0.15)" }}>
                      <Icon name="CalendarDays" size={28} style={{ color: "rgba(0,212,255,0.5)" }} />
                    </div>
                    <div className="text-center space-y-1">
                      <p className="text-white/60 text-sm font-medium">Программа передач</p>
                      <p className="text-white/25 text-xs leading-relaxed">Загрузите XMLTV файл для просмотра расписания</p>
                    </div>
                    <button onClick={() => setShowEpgInput(true)}
                      className="neon-glow-btn text-white text-sm font-semibold px-4 py-2.5 rounded-xl flex items-center gap-2">
                      <Icon name="Plus" size={15} />
                      Добавить EPG
                    </button>
                  </div>
                )}

                {/* EPG URL input */}
                {showEpgInput && (
                  <div className="p-4 space-y-3 animate-fade-in">
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-sm font-semibold" style={{ color: "#00d4ff" }}>Загрузить EPG</p>
                      <button onClick={() => { setShowEpgInput(false); setEpgError(""); }}
                        className="text-muted-foreground hover:text-white transition-colors">
                        <Icon name="X" size={14} />
                      </button>
                    </div>
                    <p className="text-xs text-muted-foreground/60">Вставьте ссылку на XMLTV (.xml / .gz)</p>
                    <input value={epgUrl} onChange={(e) => setEpgUrl(e.target.value)}
                      placeholder="https://example.com/epg.xml"
                      className="w-full px-3 py-2.5 rounded-xl text-sm outline-none text-white/90 placeholder:text-muted-foreground/40 transition-all"
                      style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
                      onFocus={(e) => { e.currentTarget.style.borderColor = "rgba(0,212,255,0.4)"; }}
                      onBlur={(e) => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)"; }}
                      onKeyDown={(e) => e.key === "Enter" && loadEpg()} />
                    {epgError && (
                      <div className="flex items-center gap-2 p-2.5 rounded-lg text-xs"
                        style={{ background: "rgba(255,50,50,0.08)", border: "1px solid rgba(255,50,50,0.2)" }}>
                        <Icon name="AlertCircle" size={13} className="text-red-400 shrink-0" />
                        <span className="text-red-400/90">{epgError}</span>
                      </div>
                    )}
                    <button onClick={loadEpg} disabled={isLoadingEpg || !epgUrl.trim()}
                      className="w-full py-2.5 rounded-xl font-bold text-sm font-rajdhani tracking-wider uppercase transition-all disabled:opacity-40"
                      style={{ background: "linear-gradient(135deg, #00d4ff, #9b59ff)", color: "white", boxShadow: "0 0 20px rgba(0,212,255,0.3)" }}>
                      {isLoadingEpg
                        ? <span className="flex items-center justify-center gap-2">
                            <span className="w-3.5 h-3.5 rounded-full border-2 border-white/20" style={{ borderTopColor: "white", animation: "spin 0.75s linear infinite" }} />
                            Загружаю...
                          </span>
                        : "Загрузить"
                      }
                    </button>
                  </div>
                )}

                {/* EPG loaded */}
                {epgData && (
                  <div className="flex flex-col h-full">
                    {/* Header */}
                    <div className="px-3 py-2 shrink-0 space-y-2">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-xs font-semibold" style={{ color: "#00d4ff" }}>
                            {epgNow.toLocaleDateString("ru-RU", { weekday: "short", day: "numeric", month: "short" })}
                          </p>
                          <p className="text-[10px] text-muted-foreground/50">{epgData.channels.length} каналов · {epgData.programs.length} передач</p>
                        </div>
                        <div className="flex gap-1.5">
                          <button onClick={() => { setEpgSearchMode(s => !s); setEpgSearch(""); }}
                            className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-white/8 transition-colors"
                            style={{ border: `1px solid ${epgSearchMode ? "rgba(0,212,255,0.4)" : "rgba(255,255,255,0.08)"}`, background: epgSearchMode ? "rgba(0,212,255,0.1)" : "transparent" }}>
                            <Icon name="Search" size={12} style={{ color: epgSearchMode ? "#00d4ff" : undefined }} className={epgSearchMode ? "" : "text-muted-foreground"} />
                          </button>
                          <button onClick={() => setShowEpgInput(true)}
                            className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-white/8 transition-colors"
                            style={{ border: "1px solid rgba(255,255,255,0.08)" }}>
                            <Icon name="RefreshCw" size={12} className="text-muted-foreground" />
                          </button>
                          <button onClick={() => { setEpgData(null); setEpgUrl(""); setEpgSelectedChannel(null); setEpgSearch(""); setEpgSearchMode(false); }}
                            className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-white/8 transition-colors"
                            style={{ border: "1px solid rgba(255,255,255,0.08)" }}>
                            <Icon name="Trash2" size={12} className="text-red-400/60" />
                          </button>
                        </div>
                      </div>

                      {/* Search input */}
                      {epgSearchMode && (
                        <div className="animate-fade-in">
                          <div className="flex items-center gap-2 px-3 py-2 rounded-xl"
                            style={{ background: "rgba(0,212,255,0.06)", border: "1px solid rgba(0,212,255,0.2)" }}>
                            <Icon name="Search" size={13} style={{ color: "#00d4ff" }} className="shrink-0" />
                            <input
                              autoFocus
                              value={epgSearch}
                              onChange={(e) => setEpgSearch(e.target.value)}
                              placeholder="Название, жанр, описание..."
                              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/40"
                              style={{ color: "rgba(255,255,255,0.85)" }}
                            />
                            {epgSearch && (
                              <button onClick={() => setEpgSearch("")}>
                                <Icon name="X" size={12} className="text-muted-foreground" />
                              </button>
                            )}
                          </div>
                          {epgSearch && (
                            <p className="text-[10px] text-muted-foreground/40 mt-1 px-1">
                              {epgSearchResults().length > 0 ? `${epgSearchResults().length} результатов` : "Ничего не найдено"}
                            </p>
                          )}
                        </div>
                      )}

                      {/* Channel picker — hide in search mode */}
                      {!epgSearchMode && (
                        <div className="overflow-x-auto pb-1" style={{ scrollbarWidth: "none" }}>
                          <div className="flex gap-1.5 w-max">
                            {epgData.channels.slice(0, 30).map((ch) => (
                              <button key={ch.id} onClick={() => setEpgSelectedChannel(ch.id)}
                                className="px-2.5 py-1 rounded-lg text-xs font-medium transition-all whitespace-nowrap shrink-0"
                                style={{
                                  background: epgSelectedChannel === ch.id ? "rgba(0,212,255,0.15)" : "rgba(255,255,255,0.04)",
                                  border: `1px solid ${epgSelectedChannel === ch.id ? "rgba(0,212,255,0.4)" : "rgba(255,255,255,0.07)"}`,
                                  color: epgSelectedChannel === ch.id ? "#00d4ff" : "rgba(255,255,255,0.5)",
                                }}>
                                {ch.name}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Programs list / Search results */}
                    <div className="flex-1 overflow-y-auto px-3 pb-4 space-y-1.5">

                      {/* ── Search results ── */}
                      {epgSearchMode && epgSearch.trim() ? (
                        epgSearchResults().length === 0 ? (
                          <div className="flex flex-col items-center justify-center py-12 gap-3">
                            <Icon name="SearchX" size={26} className="text-muted-foreground/25" />
                            <p className="text-muted-foreground/40 text-xs text-center leading-relaxed">
                              Передачи не найдены<br />
                              <span className="text-muted-foreground/25">Попробуйте другое слово</span>
                            </p>
                          </div>
                        ) : epgSearchResults().map(({ program: prog, channel: ch }) => {
                          const isCurrent = isCurrentProgram(prog);
                          const isPast = prog.stop < epgNow;
                          const q = epgSearch.toLowerCase();
                          const highlight = (text: string) => {
                            const idx = text.toLowerCase().indexOf(q);
                            if (idx === -1) return <span>{text}</span>;
                            return <>
                              {text.slice(0, idx)}
                              <mark style={{ background: "rgba(0,212,255,0.25)", color: "#00d4ff", borderRadius: 2, padding: "0 1px" }}>
                                {text.slice(idx, idx + q.length)}
                              </mark>
                              {text.slice(idx + q.length)}
                            </>;
                          };
                          const plCh = findPlaylistChannelByEpgId(ch.id);
                          return (
                            <div key={prog.id}
                              className="rounded-xl overflow-hidden transition-all group"
                              style={{
                                background: isCurrent ? "rgba(0,212,255,0.07)" : "rgba(255,255,255,0.03)",
                                border: `1px solid ${isCurrent ? "rgba(0,212,255,0.2)" : "rgba(255,255,255,0.06)"}`,
                                opacity: isPast ? 0.55 : 1,
                                cursor: plCh ? "pointer" : "default",
                              }}
                              onClick={() => { if (plCh) { playChannel(plCh); setTab("channels"); setEpgSearchMode(false); setEpgSearch(""); } }}>
                              <div className="px-3 py-2.5">
                                {/* Channel name row */}
                                <div className="flex items-center gap-1.5 mb-1.5">
                                  <div className="w-1 h-1 rounded-full shrink-0" style={{ background: "#9b59ff" }} />
                                  <span className="text-[10px] font-semibold font-rajdhani tracking-wider truncate"
                                    style={{ color: "#9b59ff" }}>{ch.name}</span>
                                  {isCurrent && (
                                    <span className="ml-auto flex items-center gap-1 text-[10px] font-rajdhani shrink-0"
                                      style={{ color: "#00d4ff" }}>
                                      <span className="w-1 h-1 rounded-full live-badge" style={{ background: "#00d4ff" }} />
                                      сейчас
                                    </span>
                                  )}
                                </div>
                                <p className="text-sm font-medium truncate text-white/90 mb-0.5">
                                  {highlight(prog.title)}
                                </p>
                                {prog.category && (
                                  <span className="inline-block text-[10px] px-1.5 py-0.5 rounded font-medium mb-1"
                                    style={{ background: "rgba(155,89,255,0.12)", color: "rgba(155,89,255,0.8)" }}>
                                    {highlight(prog.category)}
                                  </span>
                                )}
                                {prog.desc && (
                                  <p className="text-[11px] text-muted-foreground/50 line-clamp-2 leading-relaxed">
                                    {highlight(prog.desc)}
                                  </p>
                                )}
                                <div className="flex items-center justify-between mt-1.5 gap-2">
                                  <p className="text-[10px] text-muted-foreground/40 font-rajdhani">
                                    {formatEpgTime(prog.start)} — {formatEpgTime(prog.stop)}
                                  </p>
                                  {plCh && (
                                    <span className="flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                                      style={{ background: "rgba(0,212,255,0.12)", color: "#00d4ff", border: "1px solid rgba(0,212,255,0.25)" }}>
                                      <Icon name="Play" size={9} />
                                      Смотреть
                                    </span>
                                  )}
                                  {!plCh && (
                                    <span className="text-[10px] text-muted-foreground/25 shrink-0">нет в плейлисте</span>
                                  )}
                                </div>
                                {isCurrent && (
                                  <div className="mt-2 h-0.5 rounded-full overflow-hidden"
                                    style={{ background: "rgba(0,212,255,0.1)" }}>
                                    <div className="h-full rounded-full"
                                      style={{ width: `${getProgramProgress(prog)}%`, background: "linear-gradient(90deg, #00d4ff, #9b59ff)" }} />
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })
                      ) : epgSearchMode ? (
                        <div className="flex flex-col items-center justify-center py-12 gap-3">
                          <Icon name="Search" size={26} className="text-muted-foreground/20" />
                          <p className="text-muted-foreground/35 text-xs text-center leading-relaxed">
                            Введите название передачи,<br />жанр или ключевое слово
                          </p>
                        </div>

                      /* ── Channel programs ── */
                      ) : epgSelectedChannel
                        ? getChannelPrograms(epgSelectedChannel).length === 0
                          ? (
                            <div className="flex flex-col items-center justify-center py-10 gap-2">
                              <Icon name="Calendar" size={24} className="text-muted-foreground/25" />
                              <p className="text-muted-foreground/40 text-xs text-center">Нет программы на сегодня</p>
                            </div>
                          )
                          : getChannelPrograms(epgSelectedChannel).map((prog) => {
                              const isCurrent = isCurrentProgram(prog);
                              const isPast = prog.stop < epgNow;
                              const progress = getProgramProgress(prog);
                              return (
                                <div key={prog.id} className="rounded-xl overflow-hidden transition-all"
                                  style={{
                                    background: isCurrent ? "rgba(0,212,255,0.08)" : isPast ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.03)",
                                    border: `1px solid ${isCurrent ? "rgba(0,212,255,0.25)" : "rgba(255,255,255,0.06)"}`,
                                    opacity: isPast ? 0.5 : 1,
                                  }}>
                                  <div className="px-3 py-2.5">
                                    <div className="flex items-start justify-between gap-2">
                                      <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-1.5 mb-0.5">
                                          {isCurrent && (
                                            <span className="w-1.5 h-1.5 rounded-full shrink-0 live-badge"
                                              style={{ background: "#00d4ff", boxShadow: "0 0 5px #00d4ff" }} />
                                          )}
                                          <p className="text-sm font-medium truncate"
                                            style={{ color: isCurrent ? "#fff" : isPast ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.75)" }}>
                                            {prog.title}
                                          </p>
                                        </div>
                                        {prog.category && (
                                          <span className="inline-block text-[10px] px-1.5 py-0.5 rounded font-medium mb-1"
                                            style={{ background: "rgba(155,89,255,0.12)", color: "rgba(155,89,255,0.8)" }}>
                                            {prog.category}
                                          </span>
                                        )}
                                        {prog.desc && (
                                          <p className="text-[11px] text-muted-foreground/50 line-clamp-2 leading-relaxed">{prog.desc}</p>
                                        )}
                                      </div>
                                      <div className="text-right shrink-0">
                                        <p className="text-xs font-rajdhani font-semibold"
                                          style={{ color: isCurrent ? "#00d4ff" : "rgba(255,255,255,0.35)" }}>
                                          {formatEpgTime(prog.start)}
                                        </p>
                                        <p className="text-[10px] text-muted-foreground/35 font-rajdhani">
                                          {formatEpgTime(prog.stop)}
                                        </p>
                                      </div>
                                    </div>
                                    {isCurrent && (
                                      <div className="mt-2 h-1 rounded-full overflow-hidden"
                                        style={{ background: "rgba(0,212,255,0.1)" }}>
                                        <div className="h-full rounded-full transition-all"
                                          style={{ width: `${progress}%`, background: "linear-gradient(90deg, #00d4ff, #9b59ff)", boxShadow: "0 0 6px rgba(0,212,255,0.6)" }} />
                                      </div>
                                    )}
                                  </div>
                                </div>
                              );
                            })
                        : (
                          <div className="flex flex-col items-center justify-center py-10 gap-2">
                            <Icon name="ArrowUp" size={20} className="text-muted-foreground/30" />
                            <p className="text-muted-foreground/40 text-xs text-center">Выберите канал выше</p>
                          </div>
                        )
                      }
                    </div>
                  </div>
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