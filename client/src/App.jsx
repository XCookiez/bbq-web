import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import YouTubePlayer from "./components/YouTubePlayer.jsx";

const API = import.meta.env.VITE_HOST_URL;

const STORAGE_KEYS = {
  sessionId: "bbq-session-id",
  nickname: "bbq-nickname",
  role: "bbq-role",
  roomCode: "bbq-room-code"
};

function createSessionId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  if (window.crypto?.getRandomValues) {
    const bytes = window.crypto.getRandomValues(new Uint8Array(16));

    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20)
    ].join("-");
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
}

function getOrCreateSessionId() {
  const existing = localStorage.getItem(STORAGE_KEYS.sessionId);

  if (existing) {
    return existing;
  }

  const next = createSessionId();
  localStorage.setItem(STORAGE_KEYS.sessionId, next);
  return next;
}

function getStoredNickname() {
  return localStorage.getItem(STORAGE_KEYS.nickname) ?? "";
}

function getInitialRoomCode() {
  const queryRoom = new URLSearchParams(window.location.search).get("room");
  const storedRoomCode = String(localStorage.getItem(STORAGE_KEYS.roomCode) ?? "").trim().toUpperCase();
  const storedRole = localStorage.getItem(STORAGE_KEYS.role);

  if (storedRole === "host" && storedRoomCode) {
    return storedRoomCode;
  }

  return String(queryRoom ?? storedRoomCode ?? "").trim().toUpperCase();
}

function getInitialRole(initialRoomCode) {
  const storedRole = localStorage.getItem(STORAGE_KEYS.role);
  const storedRoomCode = String(localStorage.getItem(STORAGE_KEYS.roomCode) ?? "").trim().toUpperCase();
  const queryRoom = new URLSearchParams(window.location.search).get("room");

  if (storedRole === "host" && initialRoomCode && storedRoomCode === initialRoomCode) {
    return "host";
  }

  if (queryRoom) {
    return "controller";
  }

  if (initialRoomCode && (storedRole === "host" || storedRole === "controller")) {
    return storedRole;
  }

  return "";
}

function mergeSessionState(previousState, nextState) {
  return {
    ...nextState,
    session: {
      ...previousState?.session,
      ...nextState?.session
    }
  };
}

function LocalTrackArtwork({ compact = false }) {
  const className = compact ? "local-track-icon compact" : "local-track-icon";

  return (
    <div className={className} aria-hidden="true">
      <div className="record">
        <div className="record-label" />
      </div>
      <div className="record-arm" />
    </div>
  );
}

function AudioVisualizer({ isPlaying = false }) {
  const bars = Array.from({ length: 20 }, (_, index) => (
    <span
      key={index}
      className={`visualizer-bar ${isPlaying ? 'active' : ''}`}
      style={{ animationDelay: `${index * 90}ms` }}
    />
  ));

  return (
    <div className="audio-visualizer" aria-hidden="true">
      <div className="visualizer-glow" />
      <div className="visualizer-bars">{bars}</div>
    </div>
  );
}

function getActiveLyricIndex(lines, positionMs) {
  if (!lines.length) {
    return -1;
  }

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (positionMs >= lines[index].timeMs) {
      return index;
    }
  }

  return -1;
}

export default function App() {
  const navigationEntries = window.performance?.getEntriesByType?.("navigation") ?? [];
  const navigationType = navigationEntries[0]?.type ?? "navigate";
  const wasPageReloaded = navigationType === "reload";
  const isMobileDevice = /android|iphone|ipad|ipod/i.test(window.navigator.userAgent);
  const initialRoomCode = getInitialRoomCode();
  const sessionId = useMemo(() => getOrCreateSessionId(), []);
  const [activeNowPlayingTab, setActiveNowPlayingTab] = useState("music");
  const [role, setRole] = useState(() => getInitialRole(initialRoomCode));
  const [nickname, setNickname] = useState(() => getStoredNickname());
  const [nicknameDraft, setNicknameDraft] = useState(() => getStoredNickname());
  const [roomCode, setRoomCode] = useState(() => initialRoomCode);
  const [roomCodeDraft, setRoomCodeDraft] = useState(() => initialRoomCode);
  const [sessionState, setSessionState] = useState(null);
  const [youtubeQuery, setYoutubeQuery] = useState("");
  const [youtubeResults, setYoutubeResults] = useState([]);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [copiedField, setCopiedField] = useState("");
  const [playbackNeedsResume, setPlaybackNeedsResume] = useState(false);
  const [resumeToken, setResumeToken] = useState(0);
  const [shouldPromptResume, setShouldPromptResume] = useState(false);
  const [mobileYouTubeNeedsStart, setMobileYouTubeNeedsStart] = useState(false);
  const [showSkipConfirmation, setShowSkipConfirmation] = useState(false);

  const socketRef = useRef(null);
  const searchTimerRef = useRef(null);
  const searchAbortRef = useRef(null);
  const localPlayerRef = useRef(null);
  const youtubePlayerRef = useRef(null);
  const activeLyricLineRef = useRef(null);
  const progressEmitRef = useRef({ lastSentAt: 0, lastPositionMs: 0 });
  const lastAllowedTimeRef = useRef(0);
  const isRestoringTimeRef = useRef(false);

  const isHostView = role === "host";
  const currentItem = sessionState?.currentItem;
  const syncedLyrics = currentItem?.syncedLyrics ?? [];
  const activeLyricIndex = getActiveLyricIndex(syncedLyrics, sessionState?.currentPositionMs ?? 0);
  const hasSyncedLyrics = syncedLyrics.length > 0;
  const hasActiveRoom = Boolean(roomCode && role);
  const [volume, setVolume] = useState(1);
  const [quota, setQuota] = useState(null);
  const showVisibleMobileVideo = Boolean(
    isHostView &&
    isMobileDevice &&
    currentItem?.type === "local" &&
    currentItem?.mediaKind === "video" &&
    activeNowPlayingTab === "music"
  );
  const showVisibleMobileYouTube = Boolean(
    isHostView &&
    isMobileDevice &&
    currentItem?.type === "youtube" &&
    activeNowPlayingTab === "music"
  );
  const mobileHostYouTubeUnsupported = Boolean(
    isHostView &&
    isMobileDevice &&
    currentItem?.type === "youtube"
  );
  const shouldSuppressYouTubeResume = Boolean(showVisibleMobileYouTube && currentItem?.type === "youtube");

  useEffect(() => {
    const url = new URL(window.location.href);

    if (roomCode) {
      url.searchParams.set("room", roomCode);
    } else {
      url.searchParams.delete("room");
    }

    window.history.replaceState({}, "", url);
  }, [roomCode]);

  useEffect(() => {
    if (!hasActiveRoom) {
      fetch(`${API}/api/session`)
        .then((response) => response.json())
        .then((data) => setSessionState(data))
        .catch(() => {});
      return;
    }

    fetch(`${API}/api/session?room=${encodeURIComponent(roomCode)}`)
      .then(async (response) => {
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error ?? "Failed to load room.");
        }

        setSessionState(data);
      })
      .catch((error) => {
        setErrorMessage(error.message);
        resetRoomState(false);
      });
  }, [hasActiveRoom, roomCode]);

  useEffect(() => {
    if (!nickname || !role || !roomCode) {
      return undefined;
    }

    localStorage.setItem(STORAGE_KEYS.nickname, nickname);
    localStorage.setItem(STORAGE_KEYS.role, role);
    localStorage.setItem(STORAGE_KEYS.roomCode, roomCode);

    const socket = io(API,{
      auth: {
        sessionId,
        nickname,
        role,
        roomCode
      }
    });

    socket.on("session:joined", (payload) => {
      setSessionState((previous) => mergeSessionState(previous, payload.state));
      setRoomCode(payload.roomCode);
      setStatusMessage(`Connected to room ${payload.roomCode}`);
      setErrorMessage("");
    });

    socket.on("state:update", (nextState) => {
      setSessionState((previous) => mergeSessionState(previous, nextState));
    });

    socket.on("playback:progress", (payload) => {
      setSessionState((previous) => (
        previous ? { ...previous, currentPositionMs: Number(payload?.positionMs) || 0 } : previous
      ));
    });

    socket.on("room:closed", () => {
      resetRoomState(true, "This room has ended.");
    });

    socket.on("app:error", (message) => {
      setErrorMessage(message);
    });

    socket.on("connect_error", (error) => {
      setErrorMessage(error.message);

      if (!socket.active) {
        resetRoomState(false);
      }
    });

    socketRef.current = socket;

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [nickname, role, roomCode, sessionId]);

  useEffect(() => {
    if (!roomCode) {
      setYoutubeResults([]);
      window.clearTimeout(searchTimerRef.current);
      searchAbortRef.current?.abort();
      return undefined;
    }

    const trimmedQuery = youtubeQuery.trim();

    if (trimmedQuery.length < 3) {
      setYoutubeResults([]);
      window.clearTimeout(searchTimerRef.current);
      searchAbortRef.current?.abort();
      return undefined;
    }

    window.clearTimeout(searchTimerRef.current);
    searchAbortRef.current?.abort();
    searchTimerRef.current = window.setTimeout(async () => {
      setIsSearching(true);
      const controller = new AbortController();
      searchAbortRef.current = controller;

      try {
        const response = await fetch(`${API}/api/youtube/search?q=${encodeURIComponent(trimmedQuery)}`, {
          headers: {
            "x-room-code": roomCode
          },
          signal: controller.signal
        });
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error ?? "Search failed.");
        }

        setYoutubeResults(data.items);
      } catch (error) {
        if (error.name !== "AbortError") {
          setErrorMessage(error.message);
        }
      } finally {
        setIsSearching(false);
      }
    }, 350);

    return () => {
      window.clearTimeout(searchTimerRef.current);
      searchAbortRef.current?.abort();
    };
  }, [roomCode]);

  useEffect(() => {
    if (!roomCode) return;

    void fetchQuota();

    const interval = setInterval(fetchQuota, 60000);
    return () => clearInterval(interval);
  }, [roomCode]);

  async function fetchQuota() {
    try {
      const res = await fetch(`${API}/api/youtube/quota`);
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to fetch quota");
      }

      setQuota(data);
    } catch (err) {
      console.error("Quota fetch failed:", err);
    }
  }

  async function performYouTubeSearch() {
    const trimmedQuery = youtubeQuery.trim();

    if (!roomCode || trimmedQuery.length < 3) {
      setYoutubeResults([]);
      return;
    }

    setIsSearching(true);

    try {
      const response = await fetch(
          `${API}/api/youtube/search?q=${encodeURIComponent(trimmedQuery)}`,
          {
            headers: {
              "x-room-code": roomCode
            }
          }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error ?? "Search failed.");
      }

      setYoutubeResults(data.items);
      await fetchQuota();
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsSearching(false);
    }
  }

  async function fetchQuota() {
    try {
      const res = await fetch(`${API}/api/youtube/quota`);
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to fetch quota");
      }

      setQuota(data);
    } catch (err) {
      console.error("Quota fetch failed:", err);
    }
  }

  useEffect(() => {
    if (!isHostView || !localPlayerRef.current) {
      return;
    }

    if (!currentItem || currentItem.type !== "local") {
      localPlayerRef.current.pause();
      localPlayerRef.current.removeAttribute("src");
      localPlayerRef.current.load();
      return;
    }

    localPlayerRef.current.load();
  }, [currentItem?.id, currentItem?.type, isHostView]);

  useEffect(() => {
    if (!isHostView || !currentItem || currentItem.type !== "local" || !localPlayerRef.current) {
      return;
    }

    if (sessionState?.isPlaying) {
      localPlayerRef.current.play().catch(() => {});
      return;
    }

    localPlayerRef.current.pause();
  }, [currentItem?.id, currentItem?.type, isHostView, sessionState?.isPlaying]);

  useEffect(() => {
    lastAllowedTimeRef.current = 0;
    isRestoringTimeRef.current = false;
    progressEmitRef.current = { lastSentAt: 0, lastPositionMs: 0 };
    setPlaybackNeedsResume(false);
    setShouldPromptResume(Boolean(isHostView && wasPageReloaded && currentItem));
    setMobileYouTubeNeedsStart(Boolean(
      isHostView &&
      isMobileDevice &&
      currentItem?.type === "youtube"
    ));
    setSessionState((previous) => (
      previous ? { ...previous, currentPositionMs: 0 } : previous
    ));
  }, [currentItem?.id, currentItem?.type, isHostView, isMobileDevice, wasPageReloaded]);

  useEffect(() => {
    if (
      !isHostView ||
      !isMobileDevice ||
      currentItem?.type !== "youtube" ||
      !sessionState?.isPlaying ||
      !mobileYouTubeNeedsStart
    ) {
      return;
    }

    socketRef.current?.emit("host:togglePlayback", {
      isPlaying: false
    });
  }, [currentItem?.id, currentItem?.type, isHostView, isMobileDevice, mobileYouTubeNeedsStart, sessionState?.isPlaying]);

  useEffect(() => {
    if (localPlayerRef.current) {
      localPlayerRef.current.volume = volume;
    }

    if (youtubePlayerRef.current) {
      youtubePlayerRef.current.setVolume(volume);
    }
  }, [volume, currentItem?.type]);

  useEffect(() => {
    if (activeNowPlayingTab !== "lyrics" || activeLyricIndex < 0) {
      return;
    }

    const activeElement = activeLyricLineRef.current;
    const container = activeElement?.parentElement;

    if (!activeElement || !container) {
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const activeRect = activeElement.getBoundingClientRect();
    const offsetWithinContainer = activeRect.top - containerRect.top + container.scrollTop;
    const nextTop = offsetWithinContainer - (container.clientHeight / 2) + (activeRect.height / 2);

    container.scrollTo({
      top: Math.max(0, nextTop),
      behavior: "smooth"
    });
  }, [activeLyricIndex, activeNowPlayingTab]);

  function clearMessages() {
    setStatusMessage("");
    setErrorMessage("");
  }

  function resetRoomState(showMessage = false, message = "") {
    socketRef.current?.disconnect();
    socketRef.current = null;
    setRole("");
    setRoomCode("");
    setRoomCodeDraft(new URLSearchParams(window.location.search).get("room")?.toUpperCase() ?? "");
    setSessionState(null);
    setYoutubeResults([]);
    setYoutubeQuery("");
    localStorage.removeItem(STORAGE_KEYS.role);
    localStorage.removeItem(STORAGE_KEYS.roomCode);

    if (showMessage) {
      setStatusMessage(message);
      setErrorMessage("");
      return;
    }

    if (!message) {
      setStatusMessage("");
    }
  }

  function emitPlaybackProgress(positionMs) {
    if (!isHostView || !socketRef.current || !currentItem) {
      return;
    }

    const now = Date.now();
    const lastEmission = progressEmitRef.current;
    const shouldEmit = (
      now - lastEmission.lastSentAt >= 450 ||
      Math.abs(positionMs - lastEmission.lastPositionMs) >= 1200
    );

    if (!shouldEmit) {
      return;
    }

    progressEmitRef.current = {
      lastSentAt: now,
      lastPositionMs: positionMs
    };

    setSessionState((previous) => (
      previous ? { ...previous, currentPositionMs: positionMs } : previous
    ));
    socketRef.current.emit("host:updateProgress", positionMs);
  }

  async function handleStart(event) {
    event.preventDefault();
    const nextNickname = nicknameDraft.trim().slice(0, 32);
    const nextRoomCode = roomCodeDraft.trim().toUpperCase();

    if (!role) {
      setErrorMessage("Choose Host or Join first.");
      return;
    }

    if (!nextNickname) {
      setErrorMessage("Enter a nickname to continue.");
      return;
    }

    if (role === "controller" && !nextRoomCode) {
      setErrorMessage("Enter a room code to join.");
      return;
    }

    clearMessages();
    setIsJoining(true);

    try {
      localStorage.setItem(STORAGE_KEYS.nickname, nextNickname);
      setNickname(nextNickname);

      if (role === "host") {
        const response = await fetch(`${API}/api/rooms`, {
          method: "POST",
          headers: {
            "x-session-id": sessionId,
            "x-nickname": nextNickname
          }
        });
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error ?? "Failed to create room.");
        }

        setRoomCode(data.roomCode);
        setRoomCodeDraft(data.roomCode);
        setSessionState(data.state);
      } else {
        const response = await fetch(`${API}/api/session?room=${encodeURIComponent(nextRoomCode)}`);
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error ?? "Failed to join room.");
        }

        setRoomCode(nextRoomCode);
        setRoomCodeDraft(nextRoomCode);
        setSessionState(data);
      }
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsJoining(false);
    }
  }

  async function handleUpload(event) {
    const file = event.target.files?.[0];

    if (!file || !roomCode) {
      return;
    }

    clearMessages();
    setIsUploading(true);

    try {
      const formData = new FormData();
      formData.append("media", file);

      const response = await fetch(`${API}/api/uploads`, {
        method: "POST",
        headers: {
          "x-session-id": sessionId,
          "x-nickname": nickname,
          "x-room-code": roomCode
        },
        body: formData
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error ?? "Upload failed.");
      }

      setStatusMessage(`Added ${file.name} to room ${roomCode}.`);
      event.target.value = "";
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsUploading(false);
    }
  }

  function handleSearchResultClick(result) {
    clearMessages();
    socketRef.current?.emit("queue:addYouTube", result);
    setYoutubeResults([]);
    setYoutubeQuery("");
    setStatusMessage(`Added ${result.title}`);
  }

  async function copyToClipboard(value, label, field) {
    if (!value) {
      setErrorMessage(`${label} is not available yet.`);
      return;
    }

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
      } else {
        // Fallback for non-secure contexts
        const textArea = document.createElement("textarea");
        textArea.value = value;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);
      }
      
      setCopiedField(field);
      setStatusMessage(`${label} copied to clipboard!`);
      setErrorMessage("");
      
      setTimeout(() => {
        setCopiedField("");
      }, 1500);
    } catch (err) {
      console.error("Copy failed:", err);
      setErrorMessage(`Failed to copy ${label.toLowerCase()}.`);
    }
  }

  async function shareAccessCard() {
    const hostUrl = sessionState?.session?.hostUrl;

    if (!hostUrl) {
      return;
    }

    try {
      if (!navigator.share) {
        throw new Error("Share API unavailable");
      }

      await navigator.share({
        title: `Join room ${roomCode}`,
        text: `Join my LAN queue room ${roomCode}`,
        url: hostUrl
      });
      setStatusMessage("Share opened.");
      setErrorMessage("");
    } catch (error) {
      if (error?.name !== "AbortError") {
        setErrorMessage("Sharing is not available on this device.");
      }
    }
  }

  async function shareQrCode() {
    const qrCode = sessionState?.session?.qrCode;

    if (!qrCode) {
      return;
    }

    try {
      const response = await fetch(qrCode);
      const blob = await response.blob();
      const file = new File([blob], `room-${roomCode}-qr.png`, { type: blob.type || "image/png" });

      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          title: `Room ${roomCode} QR`,
          text: `Join my LAN queue room ${roomCode}`,
          files: [file]
        });
        setStatusMessage("QR ready to share.");
        setErrorMessage("");
        return;
      }

      throw new Error("File sharing unavailable");
    } catch (error) {
      if (error?.name === "AbortError") {
        return;
      }

      try {
        const link = document.createElement("a");
        link.href = qrCode;
        link.download = `room-${roomCode}-qr.png`;
        link.click();
        setStatusMessage("QR downloaded.");
        setErrorMessage("");
      } catch {
        setErrorMessage("Unable to share the QR code on this device.");
      }
    }
  }

  function voteToSkip() {
    clearMessages();
    socketRef.current?.emit("queue:voteSkip");
  }

  function togglePlayback() {
    if (!currentItem) {
      return;
    }

    if (mobileHostYouTubeUnsupported) {
      setStatusMessage("YouTube playback requires a desktop host.");
      return;
    }

    if (showVisibleMobileYouTube && mobileYouTubeNeedsStart) {
      startMobileYouTubePlayback();
      return;
    }

    const nextIsPlaying = !sessionState?.isPlaying;

    setPlaybackNeedsResume(false);
    setShouldPromptResume(false);

    if (nextIsPlaying && isHostView && currentItem.type === "local") {
      localPlayerRef.current?.play()
        .then(() => {
          setPlaybackNeedsResume(false);
          setShouldPromptResume(false);
        })
        .catch(() => {
          if (shouldPromptResume) {
            setPlaybackNeedsResume(true);
          }
        });
    }

    if (nextIsPlaying && isHostView && currentItem.type === "youtube") {
      youtubePlayerRef.current?.play();
      setResumeToken((value) => value + 1);
    }

    if (!nextIsPlaying && isHostView && currentItem.type === "youtube") {
      youtubePlayerRef.current?.pause();
    }

    socketRef.current?.emit("host:togglePlayback", {
      isPlaying: nextIsPlaying
    });
  }

  function skipCurrent() {
    setShowSkipConfirmation(true);
  }

  function confirmSkip() {
    setShowSkipConfirmation(false);
    socketRef.current?.emit("host:skip");
  }

  function cancelSkip() {
    setShowSkipConfirmation(false);
  }

  function clearQueue() {
    socketRef.current?.emit("host:clearQueue");
  }

  function removeItem(itemId) {
    socketRef.current?.emit("host:removeItem", itemId);
  }

  function leaveCurrentRoom() {
    if (isHostView) {
      socketRef.current?.emit("host:leaveRoom");
    }

    resetRoomState(true, isHostView ? "Host session closed." : "Left the room.");
  }

  function notifyPlaybackEnded() {
    socketRef.current?.emit("playback:ended");
  }

  function handlePlaybackStarted() {
    setPlaybackNeedsResume(false);
    setShouldPromptResume(false);
  }

  function handlePlaybackBlocked() {
    if (shouldSuppressYouTubeResume) {
      return;
    }

    if (isHostView && currentItem && sessionState?.isPlaying && shouldPromptResume) {
      setPlaybackNeedsResume(true);
    }
  }

  function resumePlayback() {
    if (!isHostView || !currentItem) {
      return;
    }

    setPlaybackNeedsResume(false);
    setShouldPromptResume(true);

    if (currentItem.type === "local") {
      localPlayerRef.current?.play()
        .then(() => {
          setPlaybackNeedsResume(false);
          setShouldPromptResume(false);
        })
        .catch(() => {
          if (shouldPromptResume) {
            setPlaybackNeedsResume(true);
          }
        });
      return;
    }

    setResumeToken((value) => value + 1);
  }

  function startMobileYouTubePlayback() {
    if (!showVisibleMobileYouTube || !currentItem) {
      return;
    }

    youtubePlayerRef.current?.play();
    setResumeToken((value) => value + 1);
    setMobileYouTubeNeedsStart(false);
    setPlaybackNeedsResume(false);
    setShouldPromptResume(false);
    socketRef.current?.emit("host:togglePlayback", {
      isPlaying: true
    });
  }

  function handleLocalMediaLoadedMetadata(event) {
    lastAllowedTimeRef.current = event.currentTarget.currentTime;
    emitPlaybackProgress(event.currentTarget.currentTime * 1000);
  }

  function handleLocalMediaCanPlay(event) {
    const player = event.currentTarget;

    if (isHostView && currentItem?.type === "local" && sessionState?.isPlaying) {
      player.play()
        .then(() => {
          setPlaybackNeedsResume(false);
          setShouldPromptResume(false);
        })
        .catch(() => {
          if (shouldPromptResume) {
            setPlaybackNeedsResume(true);
          }
        });
    }
  }

  function handleLocalMediaTimeUpdate(event) {
    if (isRestoringTimeRef.current) {
      return;
    }

    lastAllowedTimeRef.current = event.currentTarget.currentTime;
    setPlaybackNeedsResume(false);
    setShouldPromptResume(false);
    emitPlaybackProgress(event.currentTarget.currentTime * 1000);
  }

  function handleLocalMediaSeeking(event) {
    const player = event.currentTarget;
    const targetTime = player.currentTime;
    const allowedTime = lastAllowedTimeRef.current;

    if (Math.abs(targetTime - allowedTime) < 0.25) {
      return;
    }

    isRestoringTimeRef.current = true;
    player.currentTime = allowedTime;

    window.setTimeout(() => {
      isRestoringTimeRef.current = false;
    }, 0);
  }

  if (!role || !nickname || !roomCode) {
    return (
      <main className="app-shell landing-shell">
        <section className="card join-card">
          <p className="eyebrow">BBQueue 2.0</p>
          <h1>Choose your role</h1>
          <p className="muted">Create a private host room or join an existing one with its room code.</p>

          <div className="role-picker">
            <button
              className={`secondary-button ${role === "host" ? "is-selected" : ""}`}
              type="button"
              onClick={() => setRole("host")}
            >
              Be a host
            </button>
            <button
              className={`secondary-button ${role === "controller" ? "is-selected" : ""}`}
              type="button"
              onClick={() => setRole("controller")}
            >
              Join a room
            </button>
          </div>

          <form className="stack" onSubmit={handleStart}>
            <input
              className="text-input"
              value={nicknameDraft}
              onChange={(event) => setNicknameDraft(event.target.value)}
              placeholder="Your nickname"
              maxLength={32}
            />
            {role === "controller" ? (
              <input
                className="text-input"
                value={roomCodeDraft}
                onChange={(event) => setRoomCodeDraft(event.target.value.toUpperCase())}
                placeholder="Room code"
                maxLength={6}
              />
            ) : null}
            <button className="primary-button" type="submit" disabled={isJoining}>
              {role === "host" ? "Create host room" : "Join room"}
            </button>
          </form>

          {statusMessage ? <p className="message success">{statusMessage}</p> : null}
          {errorMessage ? <p className="message error">{errorMessage}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">{isHostView ? "Host View" : "Controller View"}</p>
          <h1>BBQueue 2.0</h1>
          <p className="muted">
            Connected as <strong>{nickname}</strong>
          </p>
        </div>
        <div className="hero-meta">
          <button className="active-button" type="button">
            <span className="hero-stat-label">Online</span>
            <strong>{sessionState?.activeUsers?.length ?? 0}</strong>
          </button>
          <button className="votes-button" type="button">
            <span className="hero-stat-label">Skip votes </span>
            <strong>{sessionState?.skipVotes ?? 0}/{sessionState?.skipThreshold ?? 1}</strong>
          </button>
          <button className="leave-room-button" type="button" onClick={leaveCurrentRoom}>
            {isHostView ? "Leave host" : "Leave room"}
          </button>
        </div>
      </section>

      {showSkipConfirmation && isHostView ? (
        <div className="confirmation-modal-overlay">
          <div className="confirmation-modal">
            <div className="confirmation-modal-header">
              <h2>Skip Current Track?</h2>
              <p>Are you sure you want to skip "{currentItem?.title}"?</p>
            </div>
            <div className="confirmation-modal-actions">
              <button className="secondary-button" onClick={cancelSkip}>
                Cancel
              </button>
              <button className="primary-button" onClick={confirmSkip}>
                Skip
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <section className="layout-grid">
        <div className="stack">
          <section className="card now-playing-card">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Now Playing</p>
                <h2>{currentItem?.title ?? "Queue is empty"}</h2>
              </div>
              {currentItem ? <span className="pill">{currentItem.type}</span> : null}
            </div>

            <div className="tab-row" role="tablist" aria-label="Now playing tabs">
              <div className="tab-buttons">
                <button
                  className={`tab-button ${activeNowPlayingTab === "music" ? "active" : ""}`}
                  type="button"
                  role="tab"
                  aria-selected={activeNowPlayingTab === "music"}
                  onClick={() => setActiveNowPlayingTab("music")}
                >
                  Music
                </button>
                <button
                  className={`tab-button ${activeNowPlayingTab === "lyrics" ? "active" : ""}`}
                  type="button"
                  role="tab"
                  aria-selected={activeNowPlayingTab === "lyrics"}
                  onClick={() => setActiveNowPlayingTab("lyrics")}
                >
                  Lyric
                </button>
              </div>
              {currentItem ? (
                <div className="now-playing-meta" aria-label="Current playback details">
                  <span className="meta-chip">
                    <span className="meta-label">Added by</span>
                    <strong>{currentItem.addedBy.nickname}</strong>
                  </span>
                  <span className={`meta-chip ${sessionState?.isPlaying ? "is-live" : ""}`}>
                    <span className="meta-dot" aria-hidden="true" />
                    <strong>{sessionState?.isPlaying ? "Playing" : "Paused"}</strong>
                  </span>
                </div>
              ) : null}
            </div>

            {currentItem ? (
              <>
                {showVisibleMobileVideo ? (
                  <video
                    key={currentItem.id}
                    ref={localPlayerRef}
                    className="mobile-host-video"
                    src={currentItem.source}
                    preload="metadata"
                    playsInline
                    controls={false}
                    controlsList="nodownload noplaybackrate nofullscreen"
                    disablePictureInPicture
                    onCanPlay={handleLocalMediaCanPlay}
                    onLoadedMetadata={handleLocalMediaLoadedMetadata}
                    onTimeUpdate={handleLocalMediaTimeUpdate}
                    onSeeking={handleLocalMediaSeeking}
                    onEnded={notifyPlaybackEnded}
                  />
                ) : showVisibleMobileYouTube ? (
                  <div className="mobile-youtube-shell">
                    <YouTubePlayer
                      ref={youtubePlayerRef}
                      videoId={currentItem.source}
                      isPlaying={false}
                      onEnded={notifyPlaybackEnded}
                      onProgress={emitPlaybackProgress}
                      onPlaybackBlocked={handlePlaybackBlocked}
                      onPlaybackStarted={handlePlaybackStarted}
                      resumeToken={resumeToken}
                      visible
                      playbackCheckDelayMs={3000}
                      volume={volume}
                    />
                    <div className="mobile-youtube-overlay mobile-youtube-message">
                      YouTube playback requires a desktop host.
                    </div>
                  </div>
                ) : activeNowPlayingTab === "music" ? (
                  <AudioVisualizer 
                    isPlaying={Boolean(sessionState?.isPlaying)}
                  />
                ) : hasSyncedLyrics ? (
                  <div className="lyrics-panel">
                    <div className="lyrics-lines" aria-live="polite">
                      {syncedLyrics.map((line, index) => (
                        <p
                          key={`${line.timeMs}-${index}`}
                          ref={index === activeLyricIndex ? activeLyricLineRef : null}
                          className={`lyric-line ${index === activeLyricIndex ? "active" : ""}`}
                        >
                          {line.text}
                        </p>
                      ))}
                    </div>
                  </div>
                ) : currentItem.lyrics ? (
                  <div className="lyrics-panel lyrics-display">{currentItem.lyrics}</div>
                ) : (
                  <div className="lyrics-panel lyrics-empty">No available lyrics for this music.</div>
                )}
                {isHostView ? (
                  currentItem.type === "youtube" && !showVisibleMobileYouTube ? (
                    <div className="sr-only-player">
                      <YouTubePlayer
                        ref={youtubePlayerRef}
                        videoId={currentItem.source}
                        isPlaying={sessionState?.isPlaying}
                        onEnded={notifyPlaybackEnded}
                        onProgress={emitPlaybackProgress}
                        onPlaybackBlocked={handlePlaybackBlocked}
                        onPlaybackStarted={handlePlaybackStarted}
                        resumeToken={resumeToken}
                        playbackCheckDelayMs={1200}
                        volume={volume}
                      />
                    </div>
                  ) : currentItem.mediaKind === "video" && !showVisibleMobileVideo ? (
                    <video
                      key={currentItem.id}
                      ref={localPlayerRef}
                      className="sr-only-player"
                      src={currentItem.source}
                      preload="auto"
                      autoPlay
                      playsInline
                      controls={false}
                      controlsList="nodownload noplaybackrate nofullscreen"
                      disablePictureInPicture
                      onCanPlay={handleLocalMediaCanPlay}
                      onLoadedMetadata={handleLocalMediaLoadedMetadata}
                      onTimeUpdate={handleLocalMediaTimeUpdate}
                      onSeeking={handleLocalMediaSeeking}
                      onEnded={notifyPlaybackEnded}
                    />
                  ) : (
                    <audio
                      key={currentItem.id}
                      ref={localPlayerRef}
                      className="sr-only-player"
                      src={currentItem.source}
                      preload="auto"
                      autoPlay
                      playsInline
                      controls={false}
                      controlsList="nodownload noplaybackrate"
                      onCanPlay={handleLocalMediaCanPlay}
                      onLoadedMetadata={handleLocalMediaLoadedMetadata}
                      onTimeUpdate={handleLocalMediaTimeUpdate}
                      onSeeking={handleLocalMediaSeeking}
                      onEnded={notifyPlaybackEnded}
                    />
                  )
                ) : null}
              </>
            ) : (
              <div className="placeholder-player">Add local media or a YouTube video to begin.</div>
            )}

            <div className="actions-row">
              <button className="primary-button" onClick={voteToSkip} disabled={!currentItem}>
                Vote to skip
              </button>
              {isHostView ? (
                <>
                  {playbackNeedsResume ? (
                    <button className="primary-button" onClick={resumePlayback} disabled={!currentItem}>
                      Resume audio
                    </button>
                  ) : null}
                  <button className="secondary-button" onClick={togglePlayback} disabled={!currentItem}>
                    {sessionState?.isPlaying ? "Pause" : "Play"}
                  </button>
                  <button className="secondary-button" onClick={skipCurrent} disabled={!currentItem || showSkipConfirmation}>
                    Skip
                  </button>
                </>
              ) : null}
            </div>

            {isHostView ? (
              <div className="volume-control">
                <label htmlFor="volume-slider" className="volume-label">Volume</label>
                <input
                  id="volume-slider"
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={volume}
                  onChange={(e) => setVolume(parseFloat(e.target.value))}
                  className="volume-slider"
                />
              </div>
            ) : null}
          </section>

          <section className="card">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Add Media</p>
                <h2>Uploads and YouTube</h2>
              </div>
            </div>

            <div className="stack">
              <label className="upload-box">
                <span>Upload MP3, WAV, or MP4</span>
                <input type="file" accept=".mp3,.wav,.mp4,audio/mpeg,audio/wav,video/mp4" onChange={handleUpload} />
              </label>

              <div className="stack">
                <div className="search-input-wrap with-button">
    <span className="search-input-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false">
        <path
            d="M10.5 4a6.5 6.5 0 1 0 4.03 11.6l4.43 4.44 1.06-1.06-4.44-4.43A6.5 6.5 0 0 0 10.5 4Zm0 1.5a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z"
            fill="currentColor"
        />
      </svg>
    </span>

                  <input
                      className="text-input search-input"
                      value={youtubeQuery}
                      onChange={(event) => setYoutubeQuery(event.target.value)}
                      placeholder="Search music..."
                  />

                  {/* 🔶 BUTTON INSIDE */}
                  <button
                      className="search-btn"
                      type="button"
                      onClick={performYouTubeSearch}
                      disabled={isSearching}
                  >
                    {isSearching ? "..." : "Search"}
                  </button>
                </div>

                {youtubeQuery.trim() && youtubeQuery.trim().length < 3 ? (
                    <p className="muted">Type at least 3 characters before searching.</p>
                ) : null}

                {isSearching ? <p className="muted">Searching...</p> : null}

                <div className="search-results">
                  {youtubeResults.map((result) => (
                      <button
                          key={result.videoId}
                          className="search-item"
                          type="button"
                          onClick={() => handleSearchResultClick(result)}
                      >
                        <img className="queue-thumbnail" src={result.thumbnail} alt={result.title} />
                        <span className="search-result-copy">
          <strong>{result.title}</strong>
          <span>{result.artist || "YouTube"}</span>
        </span>
                      </button>
                  ))}
                </div>
              </div>
            </div>
          </section>
        </div>

        <div className="stack">
          <section className="card">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Queue</p>
                <h2>Upcoming</h2>
              </div>
              {isHostView ? (
                <button className="secondary-button" onClick={clearQueue}>
                  Clear queue
                </button>
              ) : null}
            </div>

            <div className="queue-list queue-list-scroll">
              {sessionState?.queue?.length ? (
                sessionState.queue.map((item) => (
                  <article className="queue-item" key={item.id}>
                    {item.type === "local" || item.type === "youtube" ? (
                      <LocalTrackArtwork compact />
                    ) : (
                      <div className="queue-thumbnail fallback">{item.type === "local" ? "FILE" : "YT"}</div>
                    )}
                    <div className="queue-copy">
                      <strong>{item.title}</strong>
                      <span>
                        {item.type === "youtube" ? "YouTube" : item.mediaKind === "video" ? "Local video" : "Local audio"}
                        {item.artist ? ` • ${item.artist}` : ""}
                      </span>
                      <span>Added by {item.addedBy.nickname}</span>
                    </div>
                    {isHostView ? (
                      <button className="danger-button" onClick={() => removeItem(item.id)}>
                        Remove
                      </button>
                    ) : null}
                  </article>
                ))
              ) : (
                <p className="muted">No upcoming items.</p>
              )}
            </div>
          </section>

          <section className="card">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Access</p>
                <h2>LAN Share</h2>
              </div>
            </div>
            <div className="share-card">
              <div className="share-row">
                <div className="share-copy">
                  <span className="share-label">Room code</span>
                  <strong>{roomCode}</strong>
                </div>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => copyToClipboard(roomCode, "Room code", "room-code")}
                  disabled={!roomCode}
                >
                  {copiedField === "room-code" ? "✓ Copied" : "Copy"}
                </button>
              </div>
              <div className="share-row share-row-url">
                <div className="share-copy">
                  <span className="share-label">Join link</span>
                  <strong>{sessionState?.session?.hostUrl ?? "Loading..."}</strong>
                </div>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => copyToClipboard(sessionState?.session?.hostUrl ?? "", "Join link", "join-link")}
                  disabled={!sessionState?.session?.hostUrl}
                >
                  {copiedField === "join-link" ? "✓ Copied" : "Copy"}
                </button>
              </div>
              <div className="share-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={shareAccessCard}
                  disabled={!sessionState?.session?.hostUrl}
                >
                  Share link
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={shareQrCode}
                  disabled={!sessionState?.session?.qrCode}
                >
                  Share QR
                </button>
              </div>
              {sessionState?.session?.qrCode ? (
                <div className="qr-shell">
                  <img className="qr-code" src={sessionState.session.qrCode} alt="QR code for LAN access" />
                  <p className="muted">Scan or send the QR to invite people into this room quickly.</p>
                </div>
              ) : null}
            </div>
          </section>

          <section className="card">
            <div className="section-heading">
              <div>
                <p className="eyebrow">YouTube API</p>
                <h2>Daily Quota</h2>
              </div>
            </div>

            {quota ? (
                <div className="quota-card">
                  <div className="quota-header">
                    <span className="quota-label">Usage</span>
                    <strong>
                      {quota.used} / {quota.limit}
                    </strong>
                  </div>

                  <div className="quota-bar">
                    <div
                        className="quota-fill"
                        style={{
                          width: `${(quota.used / quota.limit) * 100}%`
                        }}
                    />
                  </div>

                  <p className="muted quota-remaining">
                    {quota.remaining} units remaining • resets daily
                  </p>
                </div>
            ) : (
                <p className="muted">Loading quota...</p>
            )}
          </section>
        </div>
      </section>
    </main>
  );
}
