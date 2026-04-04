import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import multer from "multer";
import QRCode from "qrcode";
import { Server } from "socket.io";
import { getLocalIpAddress } from "./lib/localNetwork.js";
import { QueueStore } from "./lib/queueStore.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const clientDistDir = path.join(rootDir, "client", "dist");
const uploadsDir = path.join(rootDir, "uploads");

fs.mkdirSync(uploadsDir, { recursive: true });

const port = Number(process.env.PORT ?? 3001);
const clientUrl = process.env.CLIENT_URL ?? "http://localhost:5173";
const localIp = getLocalIpAddress();
const publicHostUrl = String(process.env.PUBLIC_HOST_URL ?? "").trim();
const youtubeApiKey = process.env.YOUTUBE_API_KEY;
const maxUploadSizeMb = Number(process.env.MAX_UPLOAD_SIZE_MB ?? 100);
const skipThresholdRatio = Number(process.env.SKIP_THRESHOLD_RATIO ?? 0.5);
const maxItemsPerUser = Number(process.env.MAX_ITEMS_PER_USER ?? 5);
const autoDeleteUploadedFiles = String(process.env.AUTO_DELETE_UPLOADED_FILES ?? "false") === "true";
const youtubeSearchCacheTtlMs = Number(process.env.YOUTUBE_SEARCH_CACHE_TTL_MS ?? 5 * 60 * 1000);
const youtubeVideoCacheTtlMs = Number(process.env.YOUTUBE_VIDEO_CACHE_TTL_MS ?? 60 * 60 * 1000);
const youtubeSearchRateLimitWindowMs = Number(process.env.YOUTUBE_SEARCH_RATE_LIMIT_WINDOW_MS ?? 60 * 1000);
const youtubeSearchRateLimitMax = Number(process.env.YOUTUBE_SEARCH_RATE_LIMIT_MAX ?? 12);
const youtubeLinkRateLimitWindowMs = Number(process.env.YOUTUBE_LINK_RATE_LIMIT_WINDOW_MS ?? 60 * 1000);
const youtubeLinkRateLimitMax = Number(process.env.YOUTUBE_LINK_RATE_LIMIT_MAX ?? 6);
const minYouTubeSearchLength = Number(process.env.MIN_YOUTUBE_SEARCH_LENGTH ?? 3);
const lyricsCacheTtlMs = Number(process.env.LYRICS_CACHE_TTL_MS ?? 24 * 60 * 60 * 1000);
const lyricsAutoFetchEnabled = String(process.env.LYRICS_AUTO_FETCH_ENABLED ?? "true") === "true";

const allowedOrigins = new Set([
  clientUrl,
  "http://localhost:5173",
  `http://${localIp}:5173`,
  `http://localhost:${port}`,
  `http://${localIp}:${port}`
]);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: true,
    credentials: true
  }
});

const rooms = new Map();
const youtubeSearchCache = new Map();
const youtubeVideoCache = new Map();
const youtubeSearchRateLimit = new Map();
const youtubeLinkRateLimit = new Map();
const lyricsCache = new Map();
const lyricsRequests = new Map();
const hostDisconnectTimers = new Map();
const hostReconnectGraceMs = Number(process.env.HOST_RECONNECT_GRACE_MS ?? 15000);

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function createLanUrl(sourceUrl) {
  try {
    const url = new URL(sourceUrl);

    if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
      url.hostname = localIp;
    }

    return trimTrailingSlash(url.toString());
  } catch {
    return null;
  }
}

async function resolvePublicHostUrl() {
  if (publicHostUrl) {
    return trimTrailingSlash(publicHostUrl);
  }

  const lanClientUrl = createLanUrl(clientUrl);

  if (lanClientUrl) {
    try {
      await axios.get(clientUrl, {
        timeout: 1000,
        validateStatus: (status) => status < 500
      });
      return lanClientUrl;
    } catch {
      // Fall back to the API server URL when the dev client is not reachable.
    }
  }

  return `http://${localIp}:${port}`;
}

const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    cb(null, `${Date.now()}-${crypto.randomUUID()}${path.extname(file.originalname)}`);
  }
});

const allowedMimeTypes = new Set(["audio/mpeg", "audio/wav", "audio/x-wav", "video/mp4"]);
const allowedExtensions = new Set([".mp3", ".wav", ".mp4"]);

const upload = multer({
  storage: uploadStorage,
  limits: {
    fileSize: maxUploadSizeMb * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const isAllowed = allowedMimeTypes.has(file.mimetype) && allowedExtensions.has(extension);
    cb(isAllowed ? null : new Error("Only MP3, WAV, and MP4 files are allowed."), isAllowed);
  }
});

function createRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";

  while (code.length < 6) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }

  return code;
}

function getUniqueRoomCode() {
  let roomCode = createRoomCode();

  while (rooms.has(roomCode)) {
    roomCode = createRoomCode();
  }

  return roomCode;
}

function getRoomCode(value) {
  return String(value ?? "").trim().toUpperCase();
}

function getRoom(roomCode) {
  return rooms.get(getRoomCode(roomCode)) ?? null;
}

function findRoomByHostSessionId(sessionId) {
  return Array.from(rooms.values()).find((room) => room.hostSessionId === sessionId) ?? null;
}

function createRoom(hostUser) {
  const room = {
    code: getUniqueRoomCode(),
    hostSessionId: hostUser.sessionId,
    queueStore: new QueueStore({
      skipThresholdRatio,
      maxItemsPerUser,
      autoDeleteUploadedFiles
    })
  };

  rooms.set(room.code, room);
  return room;
}

async function destroyRoom(roomCode) {
  const room = getRoom(roomCode);

  if (!room) {
    return;
  }

  await room.queueStore.clearAll();
  rooms.delete(room.code);
}

async function closeRoom(roomCode) {
  const room = getRoom(roomCode);

  if (!room) {
    return;
  }

  io.to(room.code).emit("room:closed");
  const pendingTimer = hostDisconnectTimers.get(room.code);

  if (pendingTimer) {
    clearTimeout(pendingTimer);
    hostDisconnectTimers.delete(room.code);
  }

  await destroyRoom(room.code);
}

function buildBaseState(session = null) {
  return {
    currentItem: null,
    queue: [],
    isPlaying: false,
    currentPositionMs: 0,
    activeUsers: [],
    skipVotes: 0,
    skipThreshold: 1,
    maxItemsPerUser,
    roomCode: "",
    session
  };
}

function buildClientStateForRoom(room, session = null) {
  return {
    ...room.queueStore.getSnapshot(),
    roomCode: room.code,
    session
  };
}

function getSessionInfo(roomCode = "", includeQrCode = false) {
  return resolvePublicHostUrl().then((baseHostUrl) => {
    const hostUrl = roomCode ? `${baseHostUrl}?room=${encodeURIComponent(roomCode)}` : baseHostUrl;

    return (
      includeQrCode
        ? QRCode.toDataURL(hostUrl).then((qrCode) => ({ hostUrl, localIp, port, qrCode }))
        : { hostUrl, localIp, port }
    );
  });
}

function emitRoomState(roomCode) {
  const room = getRoom(roomCode);

  if (!room) {
    return;
  }

  getSessionInfo(room.code, false)
    .then((session) => io.to(room.code).emit("state:update", buildClientStateForRoom(room, session)))
    .catch((error) => console.error("Failed to emit room state:", error));
}

function getRequestIdentity(req) {
  const sessionId = String(req.header("x-session-id") ?? "").trim();
  const nickname = String(req.header("x-nickname") ?? "").trim().slice(0, 32);

  if (!sessionId || !nickname) {
    throw new Error("Missing user session headers.");
  }

  return { sessionId, nickname };
}

function getRoomFromRequest(req) {
  const roomCode = getRoomCode(req.header("x-room-code") ?? req.query.room ?? "");

  if (!roomCode) {
    throw new Error("Missing room code.");
  }

  const room = getRoom(roomCode);

  if (!room) {
    throw new Error("Room not found.");
  }

  return room;
}

function getRateLimitKey(req) {
  const sessionId = String(req.header("x-session-id") ?? "").trim();
  const forwardedFor = String(req.header("x-forwarded-for") ?? "").split(",")[0].trim();
  const remoteAddress = req.socket.remoteAddress ?? "";
  const roomCode = getRoomCode(req.header("x-room-code") ?? req.query.room ?? "");

  return [sessionId || forwardedFor || remoteAddress || "anonymous", roomCode].filter(Boolean).join("::");
}

function checkRateLimit(store, key, windowMs, maxRequests) {
  const now = Date.now();
  const windowStart = now - windowMs;
  const history = (store.get(key) ?? []).filter((timestamp) => timestamp > windowStart);

  if (history.length >= maxRequests) {
    store.set(key, history);
    return false;
  }

  history.push(now);
  store.set(key, history);
  return true;
}

function getCachedValue(store, key) {
  const cached = store.get(key);

  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    store.delete(key);
    return null;
  }

  return cached.value;
}

function setCachedValue(store, key, value, ttlMs) {
  store.set(key, {
    value,
    expiresAt: Date.now() + ttlMs
  });
}

function sanitizeTrackTitle(value) {
  return String(value ?? "")
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/\s*\((official|lyrics?|audio|video|hd|hq)[^)]+\)/gi, "")
    .replace(/\s*\[(official|lyrics?|audio|video|hd|hq)[^\]]+\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function guessTrackMetadata(title, artist = "") {
  const normalizedTitle = sanitizeTrackTitle(title);
  const normalizedArtist = String(artist ?? "").trim();

  if (normalizedArtist) {
    return {
      trackName: normalizedTitle,
      artistName: normalizedArtist
    };
  }

  const splitMatch = normalizedTitle.match(/^(.+?)\s+-\s+(.+)$/);

  if (splitMatch) {
    return {
      artistName: splitMatch[1].trim(),
      trackName: splitMatch[2].trim()
    };
  }

  return {
    artistName: "",
    trackName: normalizedTitle
  };
}

function createLyricsCacheKey(item) {
  const metadata = guessTrackMetadata(item.title, item.artist);
  return `${metadata.artistName.toLowerCase()}::${metadata.trackName.toLowerCase()}`;
}

function parseSyncedLyrics(rawLyrics) {
  const lines = String(rawLyrics ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const parsed = [];

  for (const line of lines) {
    const matches = Array.from(line.matchAll(/\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/g));
    const text = line.replace(/\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/g, "").trim();

    if (!matches.length || !text) {
      continue;
    }

    for (const match of matches) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      const fraction = String(match[3] ?? "0").padEnd(3, "0").slice(0, 3);
      const timeMs = ((minutes * 60) + seconds) * 1000 + Number(fraction);

      parsed.push({ timeMs, text });
    }
  }

  return parsed.sort((left, right) => left.timeMs - right.timeMs);
}

async function fetchLyricsFromLrclib(item) {
  const metadata = guessTrackMetadata(item.title, item.artist);
  const cacheKey = createLyricsCacheKey(item);
  const cached = getCachedValue(lyricsCache, cacheKey);

  if (cached !== null) {
    return cached;
  }

  if (lyricsRequests.has(cacheKey)) {
    return lyricsRequests.get(cacheKey);
  }

  const request = axios.get("https://lrclib.net/api/search", {
    params: {
      track_name: metadata.trackName,
      artist_name: metadata.artistName || undefined
    },
    timeout: 5000,
    validateStatus: (status) => status < 500
  }).then((response) => {
    if (response.status >= 400) {
      throw new Error("Lyrics lookup failed.");
    }

    const match = (response.data ?? []).find((entry) => entry.plainLyrics || entry.syncedLyrics) ?? null;
    const lyrics = {
      plainLyrics: match?.plainLyrics ?? "",
      syncedLyrics: parseSyncedLyrics(match?.syncedLyrics)
    };

    setCachedValue(lyricsCache, cacheKey, lyrics, lyricsCacheTtlMs);
    return lyrics;
  }).finally(() => {
    lyricsRequests.delete(cacheKey);
  });

  lyricsRequests.set(cacheKey, request);
  return request;
}

async function ensureCurrentLyrics(roomCode) {
  const room = getRoom(roomCode);

  if (!lyricsAutoFetchEnabled || !room?.queueStore.currentItem) {
    return;
  }

  if (room.queueStore.currentItem.lyrics || room.queueStore.currentItem.syncedLyrics?.length) {
    return;
  }

  try {
    const lyrics = await fetchLyricsFromLrclib(room.queueStore.currentItem);

    if ((!lyrics?.plainLyrics && !lyrics?.syncedLyrics?.length) || !room.queueStore.currentItem) {
      return;
    }

    room.queueStore.setCurrentLyrics(lyrics.plainLyrics);
    room.queueStore.currentItem.syncedLyrics = lyrics.syncedLyrics;
    emitRoomState(room.code);
  } catch (error) {
    console.warn("Automatic lyrics lookup failed:", error.message);
  }
}

function parseYouTubeVideoId(input) {
  try {
    const url = new URL(input);

    if (url.hostname.includes("youtu.be")) {
      return url.pathname.replace("/", "") || null;
    }

    if (url.hostname.includes("youtube.com")) {
      if (url.pathname === "/watch") {
        return url.searchParams.get("v");
      }

      if (url.pathname.startsWith("/shorts/") || url.pathname.startsWith("/embed/")) {
        return url.pathname.split("/").filter(Boolean).at(1) ?? null;
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function fetchYouTubeVideoDetails(videoId) {
  const cached = getCachedValue(youtubeVideoCache, videoId);

  if (cached) {
    return cached;
  }

  if (!youtubeApiKey) {
    const fallbackVideo = {
      videoId,
      title: `YouTube video (${videoId})`,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
    };

    setCachedValue(youtubeVideoCache, videoId, fallbackVideo, youtubeVideoCacheTtlMs);
    return fallbackVideo;
  }

  const response = await axios.get("https://www.googleapis.com/youtube/v3/videos", {
    params: {
      key: youtubeApiKey,
      id: videoId,
      part: "snippet"
    }
  });

  const item = response.data.items?.[0];

  if (!item) {
    throw new Error("YouTube video not found.");
  }

  const video = {
    videoId,
    title: item.snippet.title,
    thumbnail: item.snippet.thumbnails?.medium?.url ?? item.snippet.thumbnails?.default?.url ?? null
  };

  setCachedValue(youtubeVideoCache, videoId, video, youtubeVideoCacheTtlMs);
  return video;
}

function createLocalItem(file, identity) {
  const metadata = guessTrackMetadata(file.originalname);

  return {
    title: file.originalname,
    type: "local",
    source: `/uploads/${file.filename}`,
    filePath: path.join(uploadsDir, file.filename),
    mimeType: file.mimetype,
    mediaKind: file.mimetype.startsWith("video/") ? "video" : "audio",
    artist: metadata.artistName,
    addedBy: identity
  };
}

function createYouTubeItem(video, identity) {
  const metadata = guessTrackMetadata(video.title, video.artist);

  return {
    title: video.title,
    type: "youtube",
    source: video.videoId,
    thumbnail: video.thumbnail,
    artist: metadata.artistName,
    addedBy: identity
  };
}

app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());
app.use("/uploads", express.static(uploadsDir));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/session", async (req, res) => {
  const roomCode = getRoomCode(req.query.room ?? "");

  if (!roomCode) {
    const session = await getSessionInfo("", true);
    res.json(buildBaseState(session));
    return;
  }

  const room = getRoom(roomCode);

  if (!room) {
    res.status(404).json({ error: "Room not found." });
    return;
  }

  const session = await getSessionInfo(room.code, true);
  res.json(buildClientStateForRoom(room, session));
});

app.post("/api/rooms", async (req, res) => {
  try {
    const identity = getRequestIdentity(req);
    const existingRoom = findRoomByHostSessionId(identity.sessionId);

    if (existingRoom) {
      await closeRoom(existingRoom.code);
    }

    const room = createRoom(identity);
    const session = await getSessionInfo(room.code, true);

    res.status(201).json({
      roomCode: room.code,
      state: buildClientStateForRoom(room, session)
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/youtube/search", async (req, res) => {
  const query = String(req.query.q ?? "").trim();

  if (!query) {
    res.json({ items: [] });
    return;
  }

  if (query.length < minYouTubeSearchLength) {
    res.json({ items: [] });
    return;
  }

  if (!youtubeApiKey) {
    res.status(503).json({ error: "YOUTUBE_API_KEY is not configured." });
    return;
  }

  try {
    getRoomFromRequest(req);
  } catch (error) {
    res.status(400).json({ error: error.message });
    return;
  }

  const normalizedQuery = query.toLowerCase();
  const cached = getCachedValue(youtubeSearchCache, normalizedQuery);

  if (cached) {
    res.json({ items: cached, cached: true });
    return;
  }

  const rateLimitKey = getRateLimitKey(req);

  if (!checkRateLimit(
    youtubeSearchRateLimit,
    rateLimitKey,
    youtubeSearchRateLimitWindowMs,
    youtubeSearchRateLimitMax
  )) {
    res.status(429).json({ error: "Too many YouTube searches. Please wait a moment and try again." });
    return;
  }

  try {
    const response = await axios.get("https://www.googleapis.com/youtube/v3/search", {
      params: {
        key: youtubeApiKey,
        part: "snippet",
        q: query,
        type: "video",
        maxResults: 8
      }
    });

    const items = (response.data.items ?? [])
      .filter((item) => item.id?.videoId)
      .map((item) => ({
        videoId: item.id.videoId,
        title: item.snippet.title,
        artist: item.snippet.channelTitle ?? "",
        thumbnail: item.snippet.thumbnails?.medium?.url ?? item.snippet.thumbnails?.default?.url ?? null
      }));

    setCachedValue(youtubeSearchCache, normalizedQuery, items, youtubeSearchCacheTtlMs);
    res.json({ items, cached: false });
  } catch (error) {
    res.status(500).json({
      error: error.response?.data?.error?.message ?? "Failed to search YouTube."
    });
  }
});

app.post("/api/youtube/link", async (req, res) => {
  try {
    const identity = getRequestIdentity(req);
    const room = getRoomFromRequest(req);
    const rateLimitKey = getRateLimitKey(req);

    if (!checkRateLimit(
      youtubeLinkRateLimit,
      rateLimitKey,
      youtubeLinkRateLimitWindowMs,
      youtubeLinkRateLimitMax
    )) {
      res.status(429).json({ error: "Too many YouTube link lookups. Please wait a moment and try again." });
      return;
    }

    const videoId = parseYouTubeVideoId(String(req.body.url ?? ""));

    if (!videoId) {
      res.status(400).json({ error: "Invalid YouTube link." });
      return;
    }

    const video = await fetchYouTubeVideoDetails(videoId);
    const result = room.queueStore.addItem(createYouTubeItem(video, identity));
    emitRoomState(room.code);
    ensureCurrentLyrics(room.code);
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/uploads", upload.single("media"), async (req, res) => {
  try {
    const identity = getRequestIdentity(req);
    const room = getRoomFromRequest(req);

    if (!req.file) {
      res.status(400).json({ error: "No file uploaded." });
      return;
    }

    const result = room.queueStore.addItem(createLocalItem(req.file, identity));
    emitRoomState(room.code);
    ensureCurrentLyrics(room.code);
    res.status(201).json(result);
  } catch (error) {
    if (req.file?.path) {
      fs.promises.unlink(req.file.path).catch(() => {});
    }

    res.status(400).json({ error: error.message });
  }
});

app.use((error, _req, res, next) => {
  if (error instanceof multer.MulterError) {
    res.status(400).json({ error: error.message });
    return;
  }

  if (error) {
    res.status(400).json({ error: error.message });
    return;
  }

  next();
});

if (fs.existsSync(clientDistDir)) {
  app.use(express.static(clientDistDir));
  app.get(/^(?!\/api|\/socket\.io|\/uploads).*/, (_req, res) => {
    res.sendFile(path.join(clientDistDir, "index.html"));
  });
}

io.use((socket, next) => {
  const { sessionId, nickname, role, roomCode } = socket.handshake.auth ?? {};
  const normalizedRoomCode = getRoomCode(roomCode);

  if (!sessionId || !nickname || !normalizedRoomCode) {
    next(new Error("Missing session identity."));
    return;
  }

  const room = getRoom(normalizedRoomCode);

  if (!room) {
    next(new Error("Room not found."));
    return;
  }

  const normalizedRole = role === "host" ? "host" : "controller";

  if (normalizedRole === "host" && room.hostSessionId !== String(sessionId)) {
    next(new Error("Host access denied."));
    return;
  }

  socket.data.user = {
    sessionId: String(sessionId),
    nickname: String(nickname).trim().slice(0, 32),
    role: normalizedRole
  };
  socket.data.roomCode = room.code;
  next();
});

io.on("connection", async (socket) => {
  const user = socket.data.user;
  const roomCode = socket.data.roomCode;
  const room = getRoom(roomCode);

  if (!room) {
    socket.emit("room:closed");
    socket.disconnect();
    return;
  }

  const pendingTimer = hostDisconnectTimers.get(room.code);

  if (pendingTimer && user.role === "host" && room.hostSessionId === user.sessionId) {
    clearTimeout(pendingTimer);
    hostDisconnectTimers.delete(room.code);
  }

  socket.join(room.code);
  room.queueStore.attachUser(socket.id, user);

  socket.emit("session:joined", {
    user,
    roomCode: room.code,
    state: buildClientStateForRoom(room, await getSessionInfo(room.code, true))
  });
  emitRoomState(room.code);

  socket.on("queue:addYouTube", (payload) => {
    const currentRoom = getRoom(roomCode);

    if (!currentRoom) {
      socket.emit("room:closed");
      return;
    }

    try {
      const result = currentRoom.queueStore.addItem(createYouTubeItem(payload, user));
      socket.emit("queue:itemAdded", result);
      emitRoomState(currentRoom.code);
      ensureCurrentLyrics(currentRoom.code);
    } catch (error) {
      socket.emit("app:error", error.message);
    }
  });

  socket.on("queue:voteSkip", async () => {
    const currentRoom = getRoom(roomCode);

    if (!currentRoom) {
      socket.emit("room:closed");
      return;
    }

    try {
      const result = currentRoom.queueStore.registerSkipVote(user.sessionId);

      if (result.shouldSkip) {
        await currentRoom.queueStore.skipCurrentItem();
      }

      emitRoomState(currentRoom.code);
      ensureCurrentLyrics(currentRoom.code);
    } catch (error) {
      socket.emit("app:error", error.message);
    }
  });

  socket.on("playback:ended", async () => {
    if (user.role !== "host") {
      return;
    }

    const currentRoom = getRoom(roomCode);

    if (!currentRoom) {
      return;
    }

    await currentRoom.queueStore.markCurrentEnded();
    emitRoomState(currentRoom.code);
    ensureCurrentLyrics(currentRoom.code);
  });

  socket.on("host:togglePlayback", (payload) => {
    if (user.role !== "host") {
      return;
    }

    const currentRoom = getRoom(roomCode);

    if (!currentRoom) {
      return;
    }

    currentRoom.queueStore.setPlaybackState(Boolean(payload?.isPlaying));
    emitRoomState(currentRoom.code);
  });

  socket.on("host:skip", async () => {
    if (user.role !== "host") {
      return;
    }

    const currentRoom = getRoom(roomCode);

    if (!currentRoom) {
      return;
    }

    await currentRoom.queueStore.skipCurrentItem();
    emitRoomState(currentRoom.code);
    ensureCurrentLyrics(currentRoom.code);
  });

  socket.on("host:updateProgress", (positionMs) => {
    if (user.role !== "host") {
      return;
    }

    const currentRoom = getRoom(roomCode);

    if (!currentRoom) {
      return;
    }

    currentRoom.queueStore.setPlaybackPosition(positionMs);
    io.to(currentRoom.code).emit("playback:progress", {
      positionMs: currentRoom.queueStore.currentPositionMs
    });
  });

  socket.on("host:removeItem", async (itemId) => {
    if (user.role !== "host") {
      return;
    }

    const currentRoom = getRoom(roomCode);

    if (!currentRoom) {
      return;
    }

    try {
      await currentRoom.queueStore.removeQueuedItem(itemId);
      emitRoomState(currentRoom.code);
    } catch (error) {
      socket.emit("app:error", error.message);
    }
  });

  socket.on("host:clearQueue", async () => {
    if (user.role !== "host") {
      return;
    }

    const currentRoom = getRoom(roomCode);

    if (!currentRoom) {
      return;
    }

    await currentRoom.queueStore.clearAll();
    emitRoomState(currentRoom.code);
  });

  socket.on("host:leaveRoom", async () => {
    if (user.role !== "host") {
      return;
    }

    await closeRoom(roomCode);
  });

  socket.on("disconnect", async () => {
    const currentRoom = getRoom(roomCode);

    if (!currentRoom) {
      return;
    }

    currentRoom.queueStore.detachUser(socket.id);

    if (user.role === "host") {
      const timer = setTimeout(() => {
        hostDisconnectTimers.delete(currentRoom.code);
        closeRoom(currentRoom.code).catch((error) => {
          console.error("Failed to close room after host disconnect:", error);
        });
      }, hostReconnectGraceMs);

      hostDisconnectTimers.set(currentRoom.code, timer);
      return;
    }

    emitRoomState(currentRoom.code);
  });
});

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`LAN Media Queue running on http://${localIp}:${port}`);
});
